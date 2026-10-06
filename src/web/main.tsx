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
