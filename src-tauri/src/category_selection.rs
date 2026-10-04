//! Persisted, exact provider identities. An empty selection means import all.
use crate::{media_type, source_type, types::Source};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const SCHEMA: &str = "
CREATE TABLE source_category_selections (
 source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 media_type INTEGER NOT NULL CHECK(media_type IN (0,1,2)),
 category_name TEXT,
 provider_category_id TEXT
);
CREATE INDEX source_category_selections_source ON source_category_selections(source_id);
";

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CategorySelection {
    pub media_type: u8,
    pub category_name: Option<String>,
    pub provider_category_id: Option<String>,
}

pub fn get(conn: &Connection, source_id: i64) -> Result<Vec<CategorySelection>> {
    let mut stmt = conn.prepare("SELECT media_type, category_name, provider_category_id FROM source_category_selections WHERE source_id = ? ORDER BY media_type, category_name, provider_category_id")?;
    let rows = stmt.query_map([source_id], |row| {
        Ok(CategorySelection {
            media_type: row.get(0)?,
            category_name: row.get(1)?,
            provider_category_id: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn replace(tx: &Transaction, source_id: i64, selections: Vec<CategorySelection>) -> Result<()> {
    let kind: u8 = tx.query_row(
        "SELECT source_type FROM sources WHERE id = ?",
        [source_id],
        |row| row.get(0),
    )?;
    if !matches!(
        kind,
        source_type::M3U | source_type::M3U_LINK | source_type::XTREAM
    ) {
        bail!("Unsupported category selection source type");
    }
    for selection in &selections {
        if !matches!(
            selection.media_type,
            media_type::LIVESTREAM | media_type::MOVIE | media_type::SERIE
        ) {
            bail!("Invalid category media type");
        }
        if kind == source_type::XTREAM && selection.provider_category_id.is_none() {
            bail!("Xtream category ID required");
        }
    }
    tx.execute(
        "DELETE FROM source_category_selections WHERE source_id = ?",
        [source_id],
    )?;
    for selection in selections.into_iter().collect::<HashSet<_>>() {
        tx.execute("INSERT INTO source_category_selections (source_id, media_type, category_name, provider_category_id) VALUES (?, ?, ?, ?)",
            params![source_id, selection.media_type, selection.category_name, selection.provider_category_id])?;
    }
    Ok(())
}

pub fn create_source(
    tx: &Transaction,
    source: &Source,
    selections: Vec<CategorySelection>,
) -> Result<i64> {
    if source.id.is_some() {
        bail!("Expected a new source");
    }
    if source.name.trim().is_empty() {
        bail!("Source name required");
    }
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sources WHERE name = ?)",
        [&source.name],
        |row| row.get(0),
    )?;
    if exists {
        bail!("Source name already exists");
    }
    let id = crate::sql::create_or_find_source_by_name(tx, source)?;
    replace(tx, id, selections)?;
    Ok(id)
}

#[derive(Default)]
pub struct SelectionSet(HashSet<(u8, Option<String>)>);
impl SelectionSet {
    pub fn load(conn: &Connection, source_id: i64, kind: u8) -> Result<Self> {
        Ok(Self::new(get(conn, source_id)?, kind))
    }
    fn new(selections: Vec<CategorySelection>, kind: u8) -> Self {
        Self(
            selections
                .into_iter()
                .map(|s| {
                    (
                        s.media_type,
                        if kind == source_type::XTREAM {
                            s.provider_category_id
                        } else {
                            s.category_name
                        },
                    )
                })
                .collect(),
        )
    }
    pub fn includes(&self, media_type: u8, identity: Option<&str>) -> bool {
        self.0.is_empty() || self.0.contains(&(media_type, identity.map(str::to_owned)))
    }
}

pub fn saved(source_id: i64) -> Result<Vec<CategorySelection>> {
    let conn = crate::sql::get_conn()?;
    // Validate the ID even when there are no selection rows.
    conn.query_row("SELECT id FROM sources WHERE id = ?", [source_id], |row| {
        row.get::<_, i64>(0)
    })
    .context("Source not found")?;
    get(&conn, source_id)
}

#[cfg(test)]
pub(crate) fn test_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON;
        CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT UNIQUE, source_type INTEGER,
            url TEXT, username TEXT, password TEXT, use_tvg_id INTEGER, user_agent TEXT,
            max_streams INTEGER, last_updated INTEGER);
        INSERT INTO sources (id, name, source_type) VALUES (1, 'M3U test', 0), (2, 'Xtream test', 2);
        CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT, image TEXT, source_id INTEGER,
            media_type INTEGER, UNIQUE(name, source_id));
        CREATE TABLE channels (id INTEGER PRIMARY KEY, name TEXT, group_id INTEGER, image TEXT,
            url TEXT, source_id INTEGER, media_type INTEGER, series_id INTEGER, favorite INTEGER,
            stream_id INTEGER, tv_archive INTEGER, season_id INTEGER, episode_num INTEGER,
            UNIQUE(name, source_id, url, series_id, season_id));").unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selection(name: Option<&str>, media_type: u8, id: Option<&str>) -> CategorySelection {
        CategorySelection {
            category_name: name.map(str::to_owned),
            media_type,
            provider_category_id: id.map(str::to_owned),
        }
    }
    #[test]
    fn exact_m3u_identity_and_media_type_with_unfiltered_default() {
        let mut conn = test_db();
        assert!(
            SelectionSet::load(&conn, 1, source_type::M3U)
                .unwrap()
                .includes(0, Some("Any"))
        );
        let tx = conn.transaction().unwrap();
        replace(
            &tx,
            1,
            vec![
                selection(Some(" Group "), 1, None),
                selection(None, 0, None),
            ],
        )
        .unwrap();
        tx.commit().unwrap();
        let set = SelectionSet::load(&conn, 1, source_type::M3U).unwrap();
        assert!(set.includes(1, Some(" Group ")));
        assert!(!set.includes(0, Some(" Group ")));
        assert!(!set.includes(1, Some("Group")));
        assert!(!set.includes(0, Some("Excluded")));
        assert!(set.includes(0, None));
        assert!(!set.includes(0, Some("")));
    }
    #[test]
    fn replace_clear_source_isolation_and_cascade() {
        let mut conn = test_db();
        for name in ["First", "Second"] {
            let tx = conn.transaction().unwrap();
            replace(&tx, 1, vec![selection(Some(name), 0, None)]).unwrap();
            tx.commit().unwrap();
            assert_eq!(get(&conn, 1).unwrap(), vec![selection(Some(name), 0, None)]);
            assert!(get(&conn, 2).unwrap().is_empty());
        }
        let tx = conn.transaction().unwrap();
        replace(&tx, 1, vec![]).unwrap();
        tx.commit().unwrap();
        assert!(
            SelectionSet::load(&conn, 1, source_type::M3U)
                .unwrap()
                .includes(2, Some("Anything"))
        );
        let tx = conn.transaction().unwrap();
        replace(&tx, 1, vec![selection(None, 0, None)]).unwrap();
        tx.commit().unwrap();
        conn.execute("DELETE FROM sources WHERE id = 1", [])
            .unwrap();
        assert!(get(&conn, 1).unwrap().is_empty());
    }
    #[test]
    fn failed_replacement_rolls_back_previous_selection() {
        let mut conn = test_db();
        let tx = conn.transaction().unwrap();
        replace(&tx, 1, vec![selection(Some("Keep"), 0, None)]).unwrap();
        tx.commit().unwrap();
        conn.execute_batch(
            "CREATE TRIGGER fail_selection BEFORE INSERT ON source_category_selections
            WHEN NEW.category_name = 'Reject' BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
        )
        .unwrap();
        {
            let tx = conn.transaction().unwrap();
            assert!(replace(&tx, 1, vec![selection(Some("Reject"), 0, None)]).is_err());
        }
        assert_eq!(
            get(&conn, 1).unwrap(),
            vec![selection(Some("Keep"), 0, None)]
        );
    }
    #[test]
    fn xtream_identity_is_id_and_media_type_not_name() {
        let mut conn = test_db();
        let tx = conn.transaction().unwrap();
        replace(&tx, 2, vec![selection(Some("Old name"), 2, Some("0042"))]).unwrap();
        tx.commit().unwrap();
        let set = SelectionSet::load(&conn, 2, source_type::XTREAM).unwrap();
        assert!(set.includes(2, Some("0042")));
        assert!(!set.includes(0, Some("0042")));
        assert!(!set.includes(2, Some("42")));
        assert!(!set.includes(2, Some("Old name")));
        let tx = conn.transaction().unwrap();
        assert!(replace(&tx, 2, vec![selection(Some("No ID"), 0, None)]).is_err());
    }
}

#[cfg(test)]
mod creation_tests {
    use super::*;
    fn source() -> Source {
        serde_json::from_value(serde_json::json!({
            "name": "New test source", "source_type": 0, "enabled": true,
            "url": "test.m3u"
        }))
        .unwrap()
    }
    #[test]
    fn source_and_initial_selection_are_committed_together() {
        let mut conn = test_db();
        let tx = conn.transaction().unwrap();
        let selection = CategorySelection {
            media_type: 0,
            category_name: Some("Chosen".to_string()),
            provider_category_id: None,
        };
        let id = create_source(&tx, &source(), vec![selection.clone()]).unwrap();
        tx.commit().unwrap();
        assert_eq!(get(&conn, id).unwrap(), vec![selection]);
        let tx = conn.transaction().unwrap();
        assert!(create_source(&tx, &source(), vec![]).is_err());
    }
    #[test]
    fn invalid_initial_selection_leaves_no_source() {
        let mut conn = test_db();
        {
            let tx = conn.transaction().unwrap();
            let selection = CategorySelection {
                media_type: 99,
                category_name: None,
                provider_category_id: None,
            };
            assert!(create_source(&tx, &source(), vec![selection]).is_err());
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM sources", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
}
