//! Read-only pre-import dispatch. Errors deliberately omit underlying provider details.
use crate::{m3u, source_type, types::ProviderCategory, types::Source, xtream};

pub async fn analyze(source: Source) -> Result<Vec<ProviderCategory>, String> {
    match source.source_type {
        source_type::M3U => tokio::task::spawn_blocking(move || m3u::analyze_file(&source))
            .await
            .map_err(|_| "M3U analysis failed".to_string())?
            .map_err(|_| "Unable to analyze M3U file".to_string()),
        source_type::M3U_LINK => m3u::analyze_url(&source)
            .await
            .map_err(|_| "Unable to analyze M3U URL".to_string()),
        source_type::XTREAM => xtream::analyze_categories(source)
            .await
            .map_err(|_| "Unable to analyze Xtream categories".to_string()),
        _ => Err("Source type does not support category analysis".to_string()),
    }
}
