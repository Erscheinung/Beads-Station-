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

#[cfg(test)]
mod tests {
    use super::web_url;

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
