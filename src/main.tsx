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
  const [{ default: App }, { InvokeErrorBoundary }, { AppCloseGuard }, { WhatsNew }, { NotificationPanel }] = await Promise.all([
    import("./App"),
    import("./lib/invokeErrorBoundary"),
    import("./components/AppCloseGuard"),
    import("./components/WhatsNew"),
    import("./components/NotificationPanel"),
  ])
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <InvokeErrorBoundary>
        <App />
        <AppCloseGuard />
        <WhatsNew />
        <NotificationPanel />
      </InvokeErrorBoundary>
    </React.StrictMode>,
  );
  // Where the agent hook settings live; needed before the first resume command is shown.
  void import("./state/agentHooks").then(m => m.loadAgentHooks()).catch(() => {});
  // Native file drops need the Tauri webview; the browser harness has none.
  if (!import.meta.env.VITE_LIVE_MOCK) {
    void import("./lib/fileDrop").then(m => m.installTerminalFileDrop()).catch(() => {});
    // Folders opened from Finder: any that arrived before this point, then later ones.
    void Promise.all([import("./state/projects"), import("./lib/listenerRegistry")]).then(([projects, registry]) => {
      void projects.openRequestedFolders().catch(() => {});
      void registry.safeListen("app:open-folders", () => { void projects.openRequestedFolders().catch(() => {}) }).catch(() => {});
    }).catch(() => {});
  }
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
