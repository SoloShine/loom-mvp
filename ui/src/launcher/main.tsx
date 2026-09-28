import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { LauncherApp } from "@/launcher/LauncherApp";
import { initTheme } from "@/lib/theme";

// Theme class must be applied before the first render; the page ships an
// empty #root so there is no wrong-theme flash even with CSP forbidding
// inline scripts. The palette entry keeps the same anti-flash sequence.
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LauncherApp />
  </StrictMode>,
);
