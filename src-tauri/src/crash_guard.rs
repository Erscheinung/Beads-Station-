//! Keeps one bad event from killing the app and every terminal in it.
//!
//! tao's `sendEvent:` override is a plain `extern "C"` function. Anything that
//! unwinds into it, whether a Rust panic from a nested callback or an
//! NSException raised inside AppKit, aborts the process with
//! `panic_cannot_unwind`. Crash reports from 0.1.6 show exactly that stack, and
//! the abort took all in-process shells with it.
//!
//! So the method is replaced with one that catches both. tao's version also
//! queued device events for `RunEvent::DeviceEvent`, which nothing here reads.
//!
//! Panics are written to a small local log because a Finder-launched app has no
//! stderr to read afterwards; that log is how a trigger gets identified.

use std::any::Any;
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};

const MAX_LOG_BYTES: u64 = 256 * 1024;

pub(crate) fn log_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(Path::new(&home).join("Library/Logs/ai.beads-station.desktop/crash.log"))
}

fn append(path: &Path, entry: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Bounded: start over rather than grow without limit if something repeats.
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
        std::fs::remove_file(path)?;
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{} {entry}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))
}

pub(crate) fn record(entry: &str) {
    eprintln!("[crash-guard] {entry}");
    if let Some(path) = log_path() {
        let _ = append(&path, entry);
    }
}

/// Add a log line to the default panic behaviour. Never panics itself: a panic
/// inside a panic hook aborts.
pub(crate) fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let message = payload_text(info.payload());
        record(&format!(
            "panic v{} thread={} at {location}: {message}",
            env!("CARGO_PKG_VERSION"),
            thread.name().unwrap_or("unnamed"),
        ));
        previous(info);
    }));
}

fn payload_text(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-text panic payload".into())
}

/// Run `work`, turning a panic or an Objective-C exception into an `Err`.
#[cfg(target_os = "macos")]
pub(crate) fn guarded(work: impl FnOnce()) -> Result<(), String> {
    // Order matters: catch_unwind aborts on a foreign exception, so the
    // Objective-C catch has to be the inner one.
    let outcome = catch_unwind(AssertUnwindSafe(|| objc2::exception::catch(AssertUnwindSafe(work))));
    match outcome {
        Ok(Ok(())) => Ok(()),
        Ok(Err(Some(exception))) => Err(format!("exception: {exception:?}")),
        Ok(Err(None)) => Err("exception: nil".into()),
        Err(panic) => Err(format!("panic: {}", payload_text(panic.as_ref()))),
    }
}

#[cfg(target_os = "macos")]
mod event_dispatch {
    use super::{guarded, record};
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{msg_send, sel};

    const NS_EVENT_TYPE_KEY_UP: usize = 11;
    const NS_EVENT_MODIFIER_COMMAND: usize = 1 << 20;

    extern "C-unwind" fn send_event(this: &AnyObject, _sel: Sel, event: &AnyObject) {
        let dispatched = guarded(|| unsafe {
            let event_type: usize = msg_send![event, type];
            let flags: usize = msg_send![event, modifierFlags];
            // AppKit swallows key-up while Command is held; hand it to the key
            // window as tao does, so held-Command shortcuts see their release.
            if event_type == NS_EVENT_TYPE_KEY_UP && flags & NS_EVENT_MODIFIER_COMMAND != 0 {
                let window: *mut AnyObject = msg_send![this, keyWindow];
                if let Some(window) = window.as_ref() {
                    let _: () = msg_send![window, sendEvent: event];
                }
                return;
            }
            let superclass = AnyClass::get(c"NSApplication").expect("NSApplication exists");
            let _: () = msg_send![super(this, superclass), sendEvent: event];
        });
        if let Err(failure) = dispatched {
            // Losing one event is what AppKit does for exceptions in its own loop.
            record(&format!("event dropped: {failure}"));
        }
    }

    /// Must run after the event loop exists, because that registers `TaoApp`.
    pub(super) fn install() {
        let Some(class) = AnyClass::get(c"TaoApp") else {
            record("TaoApp is not registered; event guard not installed");
            return;
        };
        let Some(method) = class.instance_method(sel!(sendEvent:)) else {
            record("TaoApp has no sendEvent:; event guard not installed");
            return;
        };
        let replacement = send_event as extern "C-unwind" fn(&AnyObject, Sel, &AnyObject);
        // SAFETY: same selector and argument layout as the method it replaces.
        unsafe {
            method.set_implementation(std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel, &AnyObject), Imp>(replacement));
        }
    }
}

pub(crate) fn guard_event_dispatch() {
    #[cfg(target_os = "macos")]
    event_dispatch::install();
}

/// The tail of the crash log, for Settings → About. None when there is none.
#[tauri::command]
pub fn app_last_crash() -> Option<String> {
    let text = std::fs::read_to_string(log_path()?).ok()?;
    let lines: Vec<&str> = text.lines().collect();
    Some(lines[lines.len().saturating_sub(20)..].join("\n")).filter(|tail| !tail.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_starts_over_past_its_limit() {
        let dir = std::env::temp_dir().join(format!("bs-crash-log-{}", uuid::Uuid::new_v4()));
        let path = dir.join("nested/crash.log");
        append(&path, "first").unwrap();
        std::fs::write(&path, vec![b'x'; MAX_LOG_BYTES as usize + 1]).unwrap();
        append(&path, "second").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.ends_with("second\n") && text.len() < 100);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn guarded_survives_panics_and_objc_exceptions() {
        use objc2::rc::Retained;
        use objc2::runtime::{AnyClass, AnyObject};
        use objc2::msg_send;
        assert_eq!(guarded(|| {}), Ok(()));
        let panic = guarded(|| panic!("boom")).unwrap_err();
        assert!(panic.contains("boom"), "{panic}");
        // An NSArray out-of-bounds read raises NSRangeException.
        let exception = guarded(|| unsafe {
            let array: Retained<AnyObject> = msg_send![AnyClass::get(c"NSArray").unwrap(), array];
            let _: *mut AnyObject = msg_send![&*array, objectAtIndex: 5usize];
        })
        .unwrap_err();
        assert!(exception.contains("exception"), "{exception}");
    }
}
