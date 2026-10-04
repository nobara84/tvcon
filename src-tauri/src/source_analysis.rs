//! Read-only pre-import dispatch. Errors deliberately omit underlying provider details.
use crate::{m3u, source_type, types::ProviderCategory, types::Source, xtream};

pub async fn analyze(source: Source) -> Result<Vec<ProviderCategory>, String> {
    analyze_with_progress(source, None).await
}

pub async fn analyze_with_progress(
    source: Source,
    callback: Option<crate::analysis_progress::ProgressCallback>,
) -> Result<Vec<ProviderCategory>, String> {
    match source.source_type {
        source_type::M3U => {
            tokio::task::spawn_blocking(move || m3u::analyze_file_with_progress(&source, callback))
                .await
                .map_err(|_| "M3U analysis failed".to_string())?
                .map_err(|_| "Unable to analyze M3U file".to_string())
        }
        source_type::M3U_LINK => m3u::analyze_url_with_progress(&source, callback)
            .await
            .map_err(|_| "Unable to analyze M3U URL".to_string()),
        source_type::XTREAM => {
            let mut reporter = crate::analysis_progress::Reporter::new(callback);
            reporter.update("ANALYZING", 0, 0, None, 0, 0, true);
            let result = xtream::analyze_categories(source)
                .await
                .map_err(|_| "Unable to analyze Xtream categories".to_string())?;
            reporter.update("COMPLETE", 0, 0, None, 0, result.len(), true);
            Ok(result)
        }
        _ => Err("Source type does not support category analysis".to_string()),
    }
}
