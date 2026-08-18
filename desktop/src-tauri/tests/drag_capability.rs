//! The drag capability must match the backend origin, whatever port it lands on.
//!
//! With an Overlay titlebar macOS provides no draggable strip of its own, so the
//! window can only be moved via `data-tauri-drag-region` — which Tauri implements
//! over IPC (`invoke('plugin:window|start_dragging')`). IPC is only granted to the
//! origins named in `capabilities/drag.json`, and the backend binds an *ephemeral*
//! port, so the pattern has to be a port wildcard. Get that wrong and the window
//! silently becomes unmovable again, on macOS only, with nothing in any log.

use std::str::FromStr;
use tauri_utils::acl::RemoteUrlPattern;
use url::Url;

/// Exactly the patterns declared in capabilities/drag.json.
fn patterns() -> Vec<RemoteUrlPattern> {
    ["http://127.0.0.1:*", "http://localhost:*"]
        .iter()
        .map(|p| RemoteUrlPattern::from_str(p).expect("pattern parses"))
        .collect()
}

fn matches(url: &str) -> bool {
    let u = Url::parse(url).expect("valid url");
    patterns().iter().any(|p| p.test(&u))
}

#[test]
fn matches_any_ephemeral_port() {
    // supervisor.rs passes --port 0, so the kernel picks this — usually high.
    for port in [1024u16, 8000, 49152, 54321, 65535] {
        assert!(matches(&format!("http://127.0.0.1:{port}/")), "port {port}");
    }
}

#[test]
fn matches_spa_client_routes() {
    // React Router owns the path, so the document URL is rarely "/".
    for path in ["", "/", "/settings", "/people/12", "/albums?x=1", "/map#z"] {
        let url = format!("http://127.0.0.1:54321{path}");
        assert!(matches(&url), "{url}");
    }
}

#[test]
fn does_not_grant_anyone_else() {
    for url in [
        "http://evil.example.com/",
        "https://127.0.0.1:54321/",       // wrong scheme
        "http://127.0.0.2:54321/",        // wrong host
        "http://192.168.1.5:54321/",      // LAN, not loopback
    ] {
        assert!(!matches(url), "must not match {url}");
    }
}
