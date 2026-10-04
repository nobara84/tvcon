use std::io::Write;
use std::sync::LazyLock;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
};

use anyhow::{Context, Result, bail};
use regex::{Captures, Regex};
use rusqlite::Transaction;
use types::{Channel, Source};

use crate::types::ChannelPreserve;
use crate::{
    log, media_type, source_type,
    sql::{self, set_channel_group_id},
    types::{self, ChannelHttpHeaders},
    utils::get_user_agent_from_source,
};

static NAME_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"tvg-name="(?P<name>[^"]*)""#).unwrap());
static NAME_REGEX_ALT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#",(?P<name>[^\n\r\t]*)"#).unwrap());
static ID_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"tvg-id="(?P<id>[^"]*)""#).unwrap());
static LOGO_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"tvg-logo="(?P<logo>[^"]*)""#).unwrap());
static GROUP_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"group-title="(?P<group>[^"]*)""#).unwrap());

static HTTP_ORIGIN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"http-origin=(?P<origin>.+)"#).unwrap());
static HTTP_REFERRER_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"http-referrer=(?P<referrer>.+)"#).unwrap());
static HTTP_USER_AGENT_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"http-user-agent=(?P<user_agent>.+)"#).unwrap());

struct M3UProcessing {
    channel_line: Option<String>,
    channel_headers: Option<ChannelHttpHeaders>,
    channel_headers_set: bool,
    last_non_empty_line: Option<String>,
    groups: HashMap<String, i64>,
    source_id: i64,
    use_tvg_id: Option<bool>,
    line_count: usize,
}

/// Keeps only the pending entry and aggregated categories, never a playlist of channels.
#[derive(Default)]
struct CategoryAnalysis {
    channel_line: Option<String>,
    last_line: Option<String>,
    categories: Vec<types::ProviderCategory>,
    indices: HashMap<(Option<String>, u8), usize>,
    use_tvg_id: Option<bool>,
}

impl CategoryAnalysis {
    fn line(&mut self, line: String) {
        if line.to_uppercase().starts_with("#EXTINF") {
            self.commit();
            self.channel_line = Some(line);
        } else if !line.trim().is_empty() && !line.starts_with('#') {
            self.last_line = Some(line);
        }
    }

    fn commit(&mut self) {
        let first = self.channel_line.take();
        let second = self.last_line.take();
        if let (Some(first), Some(second)) = (first, second) {
            // Import's converter validates names and classifies media. Keep the raw
            // group separately because import intentionally trims group names.
            let name = GROUP_REGEX
                .captures(&first)
                .and_then(|caps| caps.get(1).map(|group| group.as_str().to_string()));
            if let Ok(channel) = get_channel_from_lines(first, second, 0, self.use_tvg_id) {
                let key = (name.clone(), channel.media_type);
                let index = *self.indices.entry(key).or_insert_with(|| {
                    let index = self.categories.len();
                    self.categories.push(types::ProviderCategory {
                        name,
                        media_type: channel.media_type,
                        provider_category_id: None,
                        entry_count: Some(0),
                    });
                    index
                });
                if let Some(count) = self.categories[index].entry_count.as_mut() {
                    *count += 1;
                }
            }
        }
    }

    fn finish(mut self) -> Vec<types::ProviderCategory> {
        self.commit();
        self.categories
    }
}

fn analyze_reader(
    reader: impl BufRead,
    use_tvg_id: Option<bool>,
) -> Result<Vec<types::ProviderCategory>> {
    let mut analysis = CategoryAnalysis {
        use_tvg_id,
        ..Default::default()
    };
    for line in reader.lines() {
        analysis.line(line.map_err(|_| anyhow::anyhow!("Unable to read playlist"))?);
    }
    Ok(analysis.finish())
}

pub fn analyze_file(source: &Source) -> Result<Vec<types::ProviderCategory>> {
    let path = source.url.as_ref().context("Missing playlist path")?;
    let file = File::open(path).map_err(|_| anyhow::anyhow!("Unable to open playlist"))?;
    analyze_reader(BufReader::new(file), source.use_tvg_id)
}

pub async fn analyze_url(source: &Source) -> Result<Vec<types::ProviderCategory>> {
    let user_agent = get_user_agent_from_source(source)?;
    let client = reqwest::Client::builder()
        .user_agent(user_agent)
        .build()
        .map_err(|_| anyhow::anyhow!("Unable to create playlist client"))?;
    let mut response = client
        .get(source.url.as_ref().context("Missing playlist URL")?)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|_| anyhow::anyhow!("Unable to download playlist"))?;
    let mut analysis = CategoryAnalysis {
        use_tvg_id: source.use_tvg_id,
        ..Default::default()
    };
    let mut pending = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Unable to read playlist response"))?
    {
        pending.extend_from_slice(&chunk);
        let mut consumed = 0;
        for (index, byte) in pending.iter().enumerate() {
            if *byte == b'\n' {
                let line = std::str::from_utf8(&pending[consumed..index])
                    .map_err(|_| anyhow::anyhow!("Invalid playlist encoding"))?;
                analysis.line(line.trim_end_matches('\r').to_string());
                consumed = index + 1;
            }
        }
        pending.drain(..consumed);
    }
    if !pending.is_empty() {
        let line =
            String::from_utf8(pending).map_err(|_| anyhow::anyhow!("Invalid playlist encoding"))?;
        analysis.line(line.trim_end_matches('\r').to_string());
    }
    Ok(analysis.finish())
}

pub fn read_m3u8(mut source: Source, wipe: bool) -> Result<()> {
    let path = match source.source_type {
        source_type::M3U_LINK => get_tmp_path(),
        _ => source.url.clone().context("no file path found")?,
    };
    let file = File::open(path).context("Failed to open m3u8 file")?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines().enumerate();
    let mut sql = sql::get_conn()?;
    let mut channel_preserve: Vec<ChannelPreserve> = Vec::new();
    let tx = sql.transaction()?;
    if wipe {
        channel_preserve =
            sql::get_preserve(&tx, source.id.context("no source id")?).unwrap_or_default();
        sql::wipe(&tx, source.id.context("no source id")?)?;
    } else {
        source.id = Some(sql::create_or_find_source_by_name(&tx, &source)?);
    }
    let mut processing = M3UProcessing {
        channel_headers: None,
        channel_headers_set: false,
        channel_line: None,
        groups: HashMap::new(),
        last_non_empty_line: None,
        source_id: source.id.context("no source id")?,
        use_tvg_id: source.use_tvg_id,
        line_count: 0,
    };
    while let Some((c1, l1)) = lines.next() {
        processing.line_count = c1;
        let l1 = match l1.with_context(|| format!("Failed to process line {c1}")) {
            Ok(r) => r,
            Err(e) => {
                log::log(format!("{:?}", e));
                continue;
            }
        };
        let l1_upper = l1.to_uppercase();
        if l1_upper.starts_with("#EXTINF") {
            try_commit_channel(&mut processing, &tx);
            processing.channel_line = Some(l1);
            processing.channel_headers_set = false;
        } else if l1_upper.starts_with("#EXTVLCOPT") {
            if processing.channel_headers.is_none() {
                processing.channel_headers = Some(ChannelHttpHeaders {
                    ..Default::default()
                });
            }
            if set_http_headers(
                &l1,
                processing.channel_headers.as_mut().context("no headers")?,
            ) {
                processing.channel_headers_set = true;
            }
        } else if !l1.trim().is_empty() {
            processing.last_non_empty_line = Some(l1);
        }
    }
    try_commit_channel(&mut processing, &tx);
    if wipe {
        sql::restore_preserve(&tx, source.id.context("no source id")?, channel_preserve)?;
    }
    sql::analyze(&tx)?;
    tx.commit()?;
    Ok(())
}

fn try_commit_channel(processing: &mut M3UProcessing, tx: &Transaction) {
    if let Some(channel) = processing.channel_line.take() {
        if !processing.channel_headers_set {
            processing.channel_headers = None;
        }
        commit_channel(
            channel,
            processing.last_non_empty_line.take(),
            &mut processing.groups,
            processing.channel_headers.take(),
            processing.source_id,
            processing.use_tvg_id,
            &tx,
        )
        .with_context(|| {
            format!(
                "Failed to process channel ending at line {}",
                processing.line_count
            )
        })
        .unwrap_or_else(|e| {
            log::log(format!("{:?}", e));
        });
    }
}

fn commit_channel(
    channel_line: String,
    last_line: Option<String>,
    groups: &mut HashMap<String, i64>,
    headers: Option<ChannelHttpHeaders>,
    source_id: i64,
    use_tvg_id: Option<bool>,
    tx: &Transaction,
) -> Result<()> {
    let mut channel = get_channel_from_lines(
        channel_line,
        last_line.context("missing last line")?,
        source_id,
        use_tvg_id,
    )?;
    set_channel_group_id(groups, &mut channel, tx, &source_id).unwrap_or_else(|e| {
        log::log(format!(
            "Failed to set group id for channel: {}, Error: {:?}",
            channel.name, e
        ))
    });
    sql::insert_channel(tx, channel)?;
    if let Some(mut headers) = headers {
        headers.channel_id = Some(tx.last_insert_rowid());
        sql::insert_channel_headers(tx, headers)?;
    }
    Ok(())
}

pub async fn get_m3u8_from_link(source: Source, wipe: bool) -> Result<()> {
    let user_agent = get_user_agent_from_source(&source)?;
    let client = reqwest::Client::builder().user_agent(user_agent).build()?;
    let url = source.url.clone().context("Invalid source")?;
    let mut response = client.get(&url).send().await?;
    if !response.status().is_success() {
        log::log(format!(
            "Failed to get m3u8 from link, status: {}",
            response.status()
        ));
        bail!(
            "Failed to get m3u8 from link, status: {}",
            response.status()
        );
    }
    let mut file = std::fs::File::create(get_tmp_path())?;
    while let Some(chunk) = response.chunk().await? {
        file.write(&chunk)?;
    }
    read_m3u8(source, wipe)
}

fn get_tmp_path() -> String {
    let mut path = directories::ProjectDirs::from("de", "tvcon", "tvcon")
        .unwrap()
        .cache_dir()
        .to_owned();
    if !path.exists() {
        std::fs::create_dir_all(&path).unwrap();
    }
    path.push("get.m3u");
    return path.to_string_lossy().to_string();
}

fn extract_non_empty_capture(caps: Captures) -> Option<String> {
    caps.get(1)
        .map(|m| m.as_str().to_string())
        .filter(|s| !s.trim().is_empty())
}

fn set_http_headers(line: &str, headers: &mut ChannelHttpHeaders) -> bool {
    if let Some(origin) = HTTP_ORIGIN_REGEX
        .captures(&line)
        .and_then(extract_non_empty_capture)
    {
        headers.http_origin = Some(origin);
        return true;
    } else if let Some(referrer) = HTTP_REFERRER_REGEX
        .captures(&line)
        .and_then(extract_non_empty_capture)
    {
        headers.referrer = Some(referrer);
        return true;
    } else if let Some(user_agent) = HTTP_USER_AGENT_REGEX
        .captures(&line)
        .and_then(extract_non_empty_capture)
    {
        headers.user_agent = Some(user_agent);
        return true;
    }
    return false;
}

fn get_channel_from_lines(
    first: String,
    mut second: String,
    source_id: i64,
    use_tvg_id: Option<bool>,
) -> Result<Channel> {
    second = second.trim().to_string();
    if second.is_empty() {
        bail!("second line is empty");
    }
    let name = NAME_REGEX
        .captures(&first)
        .and_then(extract_non_empty_capture)
        .or_else(|| {
            let id = || {
                ID_REGEX
                    .captures(&first)
                    .and_then(extract_non_empty_capture)
            };
            let name_alt = || {
                NAME_REGEX_ALT
                    .captures(&first)
                    .and_then(extract_non_empty_capture)
            };
            if let Some(true) = use_tvg_id {
                return id().or(name_alt());
            } else {
                return name_alt().or(id());
            }
        })
        .context("Couldn't find name from Name or ID")?;
    let group = GROUP_REGEX
        .captures(&first)
        .and_then(extract_non_empty_capture);
    let image = LOGO_REGEX
        .captures(&first)
        .and_then(extract_non_empty_capture);
    let channel = Channel {
        id: None,
        name: name.trim().to_string(),
        group: group.map(|x| x.trim().to_string()),
        image: image.map(|x| x.trim().to_string()),
        url: Some(second.clone()),
        media_type: get_media_type(second),
        source_id: Some(source_id),
        series_id: None,
        group_id: None,
        favorite: false,
        stream_id: None,
        tv_archive: None,
        season_id: None,
        episode_num: None,
        hidden: Some(false),
    };
    Ok(channel)
}

fn get_media_type(url: String) -> u8 {
    let media_type = if url.ends_with(".mp4") || url.ends_with(".mkv") {
        media_type::MOVIE
    } else {
        media_type::LIVESTREAM
    };
    return media_type;
}

#[cfg(test)]
mod test_m3u {
    use std::{env, time::Instant};

    use crate::{
        m3u::{get_channel_from_lines, get_m3u8_from_link},
        types::Source,
    };

    use super::read_m3u8;

    #[test]
    fn test_get_channel_from_lines() {
        get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Amazing Channel" tvg-name="Amazing Channel" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0,Some(true)).unwrap();
        get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Amazing Channel" tvg-name="" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0, Some(true)).unwrap();
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="" tvg-name="" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0, Some(true)).is_err());
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id=" " tvg-name="" tvg-logo="http://myurl.local/logos/amazing/amazing-1.png" group-title="The Best Channels"#.to_string()
       , r#"http://myurl.local/1234/1234/1234"#.to_string(), 0, Some(true)).is_err());
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Id Of Channel" tvg-name="Name Of Channel" tvg-logo="http://myurl.local/amazing/stuff.png" group-title="|EU| FRANCE HEVC",Alt Name Of Channel"#.to_string(), "http://myurl.local/1111/1111.ts".to_string(), 0, Some(true)).unwrap().name == "Name Of Channel");
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Id Of Channel" tvg-name="" tvg-logo="http://myurl.local/amazing/stuff.png" group-title="|EU| FRANCE HEVC",Alt Name Of Channel"#.to_string(), "http://myurl.local/1111/1111.ts".to_string(), 0, Some(true)).unwrap().name == "Id Of Channel");
        assert!(get_channel_from_lines(r#"#EXTINF:-1 tvg-id="Id Of Channel" tvg-name="" tvg-logo="http://myurl.local/amazing/stuff.png" group-title="|EU| FRANCE HEVC",Alt Name Of Channel"#.to_string(), "http://myurl.local/1111/1111.ts".to_string(), 0, Some(false)).unwrap().name == "Alt Name Of Channel");
    }
}

#[cfg(test)]
mod category_analysis_tests {
    use super::analyze_reader;
    use crate::media_type;
    use std::io::Cursor;

    #[test]
    fn counts_groups_preserving_exact_names_and_media_types() {
        let playlist = concat!(
            "#EXTM3U\n",
            "#EXTINF:-1 group-title=\" DE | News \" tvg-name=\"One\",One\n",
            "https://example.invalid/live/1.ts\n",
            "#EXTINF:-1 group-title=\" DE | News \",Two\n",
            "https://example.invalid/live/2.ts\n",
            "#EXTINF:-1 group-title=\"EN\",Three\n",
            "https://example.invalid/live/3.ts\n",
            "#EXTINF:-1 group-title=\" DE | News \",Movie\n",
            "https://example.invalid/video.mp4\n",
            "#EXTINF:-1 group-title=\" DE | News \",Other Movie\n",
            "https://example.invalid/video.mkv"
        );
        let categories = analyze_reader(Cursor::new(playlist), None).unwrap();
        assert_eq!(categories.len(), 3);
        assert_eq!(categories[0].name.as_deref(), Some(" DE | News "));
        assert_eq!(categories[0].media_type, media_type::LIVESTREAM);
        assert_eq!(categories[0].entry_count, Some(2));
        assert_eq!(categories[1].name.as_deref(), Some("EN"));
        assert_eq!(categories[1].entry_count, Some(1));
        assert_eq!(categories[2].media_type, media_type::MOVIE);
        assert_eq!(categories[2].entry_count, Some(2));
        assert!(
            categories
                .iter()
                .all(|category| category.provider_category_id.is_none())
        );
    }

    #[test]
    fn minimal_and_malformed_entries_do_not_panic_or_reuse_urls() {
        let playlist = concat!(
            "#EXTM3U\n",
            "https://example.invalid/orphan.ts\n",
            "#EXTINF:-1 group-title=\"Missing URL\",Missing\n",
            "#EXTINF:-1,Minimal\r\n",
            "#EXTVLCOPT:http-user-agent=Test\r\n",
            "https://example.invalid/1.ts\r\n\r\n",
            "#EXTINF:-1\nhttps://example.invalid/2.ts\n",
            "#EXTINF:-1 group-title=\"Dangling\",Dangling\n"
        );
        let categories = analyze_reader(Cursor::new(playlist), Some(true)).unwrap();
        assert_eq!(categories.len(), 1);
        assert_eq!(categories[0].name, None);
        assert_eq!(categories[0].entry_count, Some(1));
        assert!(
            analyze_reader(Cursor::new("#EXTM3U\n"), None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn invalid_encoding_returns_a_generic_error() {
        let error = analyze_reader(Cursor::new(vec![0xff, b'\n']), None).unwrap_err();
        assert_eq!(error.to_string(), "Unable to read playlist");
    }
}
