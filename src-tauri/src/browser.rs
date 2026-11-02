//! Browser windows for pages that refuse to be shown inside a pane.
//!
//! A browser pane is an iframe, and many sites (sign-in pages above all)
//! forbid framing. Those open here instead: a separate native window whose
//! web view keeps its own cookies and site data between launches and uses the
//! system's certificate trust. It is not Safari's or Chrome's profile.
//!
//! These windows get no access to the app: the IPC capability names only the
//! main window.
use std::sync::atomic::{AtomicU32, Ordering};

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

/// Only ordinary web addresses are opened.
pub fn web_url(raw: &str) -> Result<tauri::Url, String> {
    let url: tauri::Url = raw.trim().parse().map_err(|_| "That is not a web address".to_string())?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        _ => Err("Only http and https addresses can be opened".into()),
    }
}

#[tauri::command]
pub async fn browser_open_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = web_url(&url)?;
    let title = url.host_str().unwrap_or("Browser").to_string();
    let label = format!("browser-{}", NEXT_WINDOW.fetch_add(1, Ordering::SeqCst));
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(url))
        .title(title)
        .inner_size(1180.0, 820.0)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Whether these response headers forbid showing the page in another app's frame.
fn forbids_framing(frame_options: Option<&str>, policy: Option<&str>) -> bool {
    if frame_options.is_some_and(|value| {
        let value = value.trim().to_ascii_lowercase();
        value == "deny" || value == "sameorigin"
    }) {
        return true;
    }
    policy.is_some_and(|policy| {
        policy.split(';').any(|directive| {
            let mut parts = directive.split_whitespace();
            parts.next().is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors"))
                && !parts.any(|source| source == "*")
        })
    })
}

/// Lets a pane say why a site is blank instead of showing an empty frame.
/// False when unknown: a failed check must not hide a page that would load.
#[tauri::command]
pub async fn browser_refuses_framing(url: String) -> Result<bool, String> {
    let url = web_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(4)).build();
        let response = match agent.get(url.as_str()).call() {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(_) => return false,
        };
        forbids_framing(response.header("x-frame-options"), response.header("content-security-policy"))
    })
    .await
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{forbids_framing, web_url};

    #[test]
    fn recognizes_headers_that_forbid_framing() {
        assert!(forbids_framing(Some("DENY"), None));
        assert!(forbids_framing(Some(" sameorigin "), None));
        assert!(forbids_framing(None, Some("default-src 'self'; frame-ancestors 'self'")));
        assert!(forbids_framing(None, Some("frame-ancestors 'none'")));
        assert!(!forbids_framing(None, Some("frame-ancestors *")));
        assert!(!forbids_framing(None, Some("default-src 'self'")));
        assert!(!forbids_framing(None, None));
    }

    #[test]
    fn opens_only_http_and_https_addresses() {
        assert!(web_url("https://example.com/a?b=1").is_ok());
        assert!(web_url(" http://localhost:3000 ").is_ok());
        assert!(web_url("file:///etc/passwd").is_err());
        assert!(web_url("javascript:alert(1)").is_err());
        assert!(web_url("tauri://localhost").is_err());
        assert!(web_url("not a url").is_err());
    }
}
