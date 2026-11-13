//! "Open Folder in Beads Station" in Finder's right-click menu (Quick Actions /
//! Services). Declared under NSServices in Info.plist; macOS calls this object
//! with the selected folders on a pasteboard. It uses the same path as Open With.
//!
//! A service needs a selected folder, so it is not offered on the empty
//! background of a Finder window. That takes a Finder Sync extension, which
//! needs a Developer ID.

use crate::{app_lifecycle, crash_guard};
use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
use objc2::{msg_send, sel};
use std::ffi::CStr;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// File paths on a pasteboard.
unsafe fn pasteboard_paths(pasteboard: &AnyObject) -> Vec<PathBuf> {
    let url_class = AnyClass::get(c"NSURL").expect("NSURL exists") as *const AnyClass as *const AnyObject;
    let array_class = AnyClass::get(c"NSArray").expect("NSArray exists");
    let classes: *mut AnyObject = msg_send![array_class, arrayWithObject: url_class];
    let urls: *mut AnyObject = msg_send![pasteboard, readObjectsForClasses: classes, options: std::ptr::null_mut::<AnyObject>()];
    let Some(urls) = urls.as_ref() else { return Vec::new() };
    let count: usize = msg_send![urls, count];
    (0..count)
        .filter_map(|index| {
            let url: *mut AnyObject = msg_send![urls, objectAtIndex: index];
            let path: *mut AnyObject = msg_send![url, path];
            let path = path.as_ref()?;
            let text: *const std::ffi::c_char = msg_send![path, UTF8String];
            (!text.is_null()).then(|| PathBuf::from(CStr::from_ptr(text).to_string_lossy().into_owned()))
        })
        .collect()
}

extern "C-unwind" fn open_folder(_this: *mut AnyObject, _sel: Sel, pasteboard: *mut AnyObject, _user_data: *mut AnyObject, _error: *mut *mut AnyObject) {
    let opened = crash_guard::guarded(|| {
        // SAFETY: AppKit passes a live pasteboard, or nil.
        let Some(pasteboard) = (unsafe { pasteboard.as_ref() }) else { return };
        let folders = app_lifecycle::folder_paths(unsafe { pasteboard_paths(pasteboard) });
        let Some(app) = APP.get() else { return };
        let requests = app.state::<app_lifecycle::OpenRequests>();
        app_lifecycle::queue_open_requests(app, &requests, folders);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    });
    if let Err(failure) = opened {
        crash_guard::record(&format!("finder service failed: {failure}"));
    }
}

/// Register the object macOS calls. Must run on the main thread at launch.
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let superclass = AnyClass::get(c"NSObject").expect("NSObject exists");
    let Some(mut builder) = ClassBuilder::new(c"BSFinderService", superclass) else { return };
    let method = open_folder as extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject, *mut *mut AnyObject);
    // SAFETY: the signature matches `openFolder:userData:error:`.
    unsafe {
        builder.add_method(sel!(openFolder:userData:error:), method);
        let class = builder.register();
        // Lives as long as the app: NSApplication does not retain its provider.
        let provider: *mut AnyObject = msg_send![class, new];
        let application: *mut AnyObject = msg_send![AnyClass::get(c"NSApplication").expect("NSApplication exists"), sharedApplication];
        let _: () = msg_send![application, setServicesProvider: provider];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::rc::Retained;

    #[test]
    fn reads_file_urls_from_a_pasteboard() {
        unsafe {
            let pasteboard: Retained<AnyObject> = msg_send![AnyClass::get(c"NSPasteboard").unwrap(), pasteboardWithUniqueName];
            let _: isize = msg_send![&*pasteboard, clearContents];
            let path: Retained<AnyObject> = msg_send![AnyClass::get(c"NSString").unwrap(), stringWithUTF8String: c"/tmp/some folder".as_ptr()];
            let url: Retained<AnyObject> = msg_send![AnyClass::get(c"NSURL").unwrap(), fileURLWithPath: &*path];
            let list: Retained<AnyObject> = msg_send![AnyClass::get(c"NSArray").unwrap(), arrayWithObject: &*url];
            let wrote: bool = msg_send![&*pasteboard, writeObjects: &*list];
            assert!(wrote);
            assert_eq!(pasteboard_paths(&pasteboard), vec![PathBuf::from("/tmp/some folder")]);
        }
    }
}
