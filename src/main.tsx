import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "./index.css";
import "@vscode/codicons/dist/codicon.css";
import App from "./App";
import { InvokeErrorBoundary } from "./lib/invokeErrorBoundary";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <InvokeErrorBoundary>
      <App />
    </InvokeErrorBoundary>
  </React.StrictMode>,
);
