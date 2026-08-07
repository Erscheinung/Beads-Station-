import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "./index.css";
import "@vscode/codicons/dist/codicon.css";
import App from "./App";
import { InvokeErrorBoundary } from "./lib/invokeErrorBoundary";

function mount() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <InvokeErrorBoundary>
        <App />
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
    mount();
  });
} else {
  mount();
}
