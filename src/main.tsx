import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "./index.css";
import "@vscode/codicons/dist/codicon.css";
import { hydrateDurableUserConfig } from "./lib/durableUserConfig";

async function mount() {
  // Hydrate the native app-data cache before importing stateful React modules.
  // Their initial snapshots then see the same preferences after a DMG upgrade,
  // even when WebKit assigned the installed app a fresh localStorage origin.
  await hydrateDurableUserConfig()
  const [{ default: App }, { InvokeErrorBoundary }, { AppCloseGuard }] = await Promise.all([
    import("./App"),
    import("./lib/invokeErrorBoundary"),
    import("./components/AppCloseGuard"),
  ])
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <InvokeErrorBoundary>
        <App />
        <AppCloseGuard />
      </InvokeErrorBoundary>
    </React.StrictMode>,
  );
}

// R12: browser-mode live-verify. When VITE_LIVE_MOCK is set, install the
// mockIPC shim BEFORE mounting so the app's mount-time invokes resolve against
// fixtures instead of a (missing) Tauri runtime. The dynamic import + the
// statically-undefined flag let Vite tree-shake the harness out of prod builds.
if (import.meta.env.VITE_LIVE_MOCK) {
  import("./test-harness/boot").then(m => {
    m.installMockIpc();
    void mount();
  });
} else {
  void mount();
}
