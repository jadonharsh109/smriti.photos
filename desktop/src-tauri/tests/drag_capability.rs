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

/// Every capability file must also be *switched on* in tauri.conf.json.
///
/// This is the trap that shipped a broken fix: `app.security.capabilities` is an
/// explicit whitelist, so a capability file can be parsed, resolved and written
/// into the build output while never being activated. Nothing fails — the
/// command is simply absent from the ACL at runtime, and in a release build the
/// rejection reads only "not allowed by ACL" with no hint that the capability
/// exists but is dormant.
#[test]
fn every_capability_file_is_activated() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("tauri.conf.json")).unwrap())
            .unwrap();
    let enabled: Vec<String> = conf["app"]["security"]["capabilities"]
        .as_array()
        .expect("app.security.capabilities must stay an explicit whitelist")
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();

    for entry in std::fs::read_dir(dir.join("capabilities")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let cap: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let id = cap["identifier"].as_str().expect("capability needs an identifier");
        assert!(
            enabled.iter().any(|e| e == id),
            "capability {:?} ({}) is never activated — add {:?} to \
             app.security.capabilities in tauri.conf.json, or delete the file",
            path.file_name().unwrap(),
            id,
            id
        );
    }
}
