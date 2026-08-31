import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./index.css";
import App from "./App";
import { useAppStore } from "./lib/agent-store";

// Dev-only: lets the browser preview drive the store without a Tauri backend.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__store = useAppStore;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
