#!/bin/sh
# Finder/launchd sessions on macOS can retain a 256-file soft limit. Vite can
# announce that it is ready and then stall while loading the frontend module
# graph at that limit, which leaves the Tauri webview blank. Raise only this
# command's limit; the Rust process performs the equivalent bootstrap itself.
if [ "$(uname -s)" = "Darwin" ]; then
  ulimit -n 8192 2>/dev/null || true
fi

exec "$@"
