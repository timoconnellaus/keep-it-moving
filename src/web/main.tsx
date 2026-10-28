import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Home } from "./Home.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(
  <StrictMode>
    {window.location.pathname.startsWith("/s/") ? <App /> : <Home />}
  </StrictMode>,
);

// Installable as an app, and the target of push notifications.
if ("serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
