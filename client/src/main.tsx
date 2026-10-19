import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.css";
import "./index.css";
import App from "./App.tsx";
import { startAppearance } from "./lib/appearance";
import { startAutoUpdates } from "./lib/updater";

startAppearance();
startAutoUpdates();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
