// Dark/light theming: explicit choice persists in localStorage; with no
// choice the UI follows the OS. initTheme() runs before the first React
// render, and since the page ships an empty #root there is no flash.

const KEY = "mini-theme";

export type Theme = "light" | "dark";

export function resolveTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === "dark" || saved === "light") return saved;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function initTheme() {
  applyTheme(resolveTheme());
}

export function saveTheme(theme: Theme) {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

/** Follow live OS theme changes while the user has not made an explicit choice. */
export function watchSystemTheme(onChange: (theme: Theme) => void) {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    if (!localStorage.getItem(KEY)) onChange(e.matches ? "dark" : "light");
  });
}
