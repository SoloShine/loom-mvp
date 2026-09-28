import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ToastProvider } from "@/components/toast";
import { initTheme } from "@/lib/theme";

// Theme class must be applied before the first render; the page ships an
// empty #root so there is no wrong-theme flash even with CSP forbidding
// inline scripts.
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
