//! Informational local tunnel detection, independent of the public address lookup.
use serde::Serialize;
use std::{net::IpAddr, time::Duration};

const PUBLIC_IP_ENDPOINT: &str = "https://api.ipify.org";

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VpnState {
    Active,
    Inactive,
    Unknown,
}

#[derive(Debug, Serialize)]
pub struct NetworkStatus {
    state: VpnState,
    interface: Option<String>,
    public_ip: Option<String>,
}

#[cfg(target_os = "linux")]
fn detect(links: &serde_json::Value, routes: &serde_json::Value) -> (VpnState, Option<String>) {
    let (Some(links), Some(routes)) = (links.as_array(), routes.as_array()) else {
        return (VpnState::Unknown, None);
    };
    for link in links {
        let name = link["ifname"].as_str().unwrap_or_default();
        let kind = link["linkinfo"]["info_kind"].as_str().unwrap_or_default();
        let tunnel = matches!(
            kind,
            "wireguard" | "tun" | "tap" | "ipip" | "sit" | "vti" | "vti6" | "gre" | "ip6gre"
        ) || ["nordlynx", "wg", "tun", "tap", "vpn", "proton"]
            .iter()
            .any(|prefix| name.to_lowercase().starts_with(prefix));
        let up = link["flags"]
            .as_array()
            .is_some_and(|flags| flags.iter().any(|flag| flag == "UP"));
        let routed = routes.iter().any(|route| {
            route["dev"] == name
                && route["type"] != "local"
                && route["type"] != "unreachable"
                && route["scope"] != "host"
                && !route["flags"]
                    .as_array()
                    .is_some_and(|flags| flags.iter().any(|flag| flag == "linkdown"))
        });
        if tunnel && up && routed {
            return (VpnState::Active, Some(name.to_owned()));
        }
    }
    (VpnState::Inactive, None)
}

#[cfg(target_os = "linux")]
async fn local_status() -> (VpnState, Option<String>) {
    // iproute2's structured netlink output includes policy-routing tables used by NordLynx.
    // No shell, elevation, provider data, or locale-dependent text parsing.
    async fn json(args: &[&str]) -> Option<serde_json::Value> {
        let output = tokio::time::timeout(
            Duration::from_secs(2),
            tokio::process::Command::new("ip")
                .args(args)
                .kill_on_drop(true)
                .output(),
        )
        .await
        .ok()?
        .ok()?;
        if !output.status.success() {
            return None;
        }
        serde_json::from_slice(&output.stdout).ok()
    }
    let (links, v4, v6) = tokio::join!(
        json(&["-j", "-d", "link", "show"]),
        json(&["-j", "-4", "route", "show", "table", "all"]),
        json(&["-j", "-6", "route", "show", "table", "all"])
    );
    match (links, v4, v6) {
        (Some(links), Some(mut routes), Some(v6)) if routes.is_array() && v6.is_array() => {
            routes
                .as_array_mut()
                .unwrap()
                .extend(v6.as_array().unwrap().iter().cloned());
            detect(&links, &routes)
        }
        _ => (VpnState::Unknown, None),
    }
}

#[cfg(not(target_os = "linux"))]
async fn local_status() -> (VpnState, Option<String>) {
    (VpnState::Unknown, None)
}

fn parse_public_ip(value: &str) -> Option<String> {
    value.trim().parse::<IpAddr>().ok().map(|ip| ip.to_string())
}

async fn public_ip() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .ok()?;
    let response = client
        .get(PUBLIC_IP_ENDPOINT)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    if response.content_length().is_some_and(|len| len > 128) {
        return None;
    }
    parse_public_ip(&response.text().await.ok()?)
}

#[tauri::command]
pub async fn get_network_status() -> NetworkStatus {
    let ((state, interface), public_ip) = tokio::join!(local_status(), public_ip());
    NetworkStatus {
        state,
        interface,
        public_ip,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_address_is_validated() {
        assert_eq!(parse_public_ip(" 185.1.2.3\n"), Some("185.1.2.3".into()));
        assert_eq!(parse_public_ip("error"), None);
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn tunnels_require_up_state_and_routes() {
        use serde_json::json;
        let links = json!([{ "ifname":"custom-tunnel", "flags":["UP"], "linkinfo":{"info_kind":"wireguard"} }]);
        let routes = json!([{ "dev":"custom-tunnel", "dst":"default", "table":51820 }]);
        assert_eq!(detect(&links, &routes).0, VpnState::Active);
        assert_eq!(detect(&links, &json!([])).0, VpnState::Inactive);
        assert_eq!(
            detect(
                &json!([{ "ifname":"nordlynx", "flags":[] }]),
                &json!([{ "dev":"nordlynx" }])
            )
            .0,
            VpnState::Inactive
        );
        assert_eq!(detect(&json!(null), &routes).0, VpnState::Unknown);
        assert_eq!(
            detect(
                &json!([{ "ifname":"nordlynx", "flags":["UP"] }]),
                &json!([{ "dev":"nordlynx", "dst":"default", "table":205 }])
            )
            .0,
            VpnState::Active
        );
    }
}
