import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./fonts.css";
import "./index.css";
import App from "./App.tsx";
import { startAppearance } from "./lib/appearance";
import { startBootPrefetch } from "./lib/bootPrefetch";
import { startEmojiSize } from "./lib/emojiSize";
import { startAutoUpdates } from "./lib/updater";

startAppearance();
startEmojiSize();
// Before anything is drawn: the person, the lists and the open chat's messages are asked for together, not one after another (#249).
startBootPrefetch(window.location.pathname);
startAutoUpdates();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
