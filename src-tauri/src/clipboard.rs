//! Reading the system clipboard as text for Command+V in a terminal, when the
//! WebView delivered no paste event of its own. `pbpaste` is the OS's own tool:
//! no extra dependency, no permission prompt, and it never launches anything.

/// Clipboard text above this size is not pasted into a terminal.
const MAX_BYTES: usize = 4 * 1024 * 1024;

fn decode(bytes: Vec<u8>) -> Option<String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok().filter(|text| !text.is_empty())
}

#[tauri::command]
pub async fn clipboard_read_text() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            let output = std::process::Command::new("/usr/bin/pbpaste")
                .args(["-Prefer", "txt"])
                .env("LANG", "en_US.UTF-8")
                .output()
                .map_err(|error| format!("could not read the clipboard: {error}"))?;
            Ok(if output.status.success() { decode(output.stdout) } else { None })
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_text_and_rejects_empty_binary_and_oversized() {
        assert_eq!(decode("héllo\n".as_bytes().to_vec()).as_deref(), Some("héllo\n"));
        assert_eq!(decode(Vec::new()), None);
        assert_eq!(decode(vec![0xff, 0xfe]), None);
        assert_eq!(decode(vec![b'a'; MAX_BYTES + 1]), None);
    }
}
