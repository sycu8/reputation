const THEME_KEY = "pulsewatch-theme";

export function resolveTheme(stored = localStorage.getItem(THEME_KEY)) {
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  const toggle = document.querySelector("#themeToggle");
  if (toggle) {
    const isDark = next === "dark";
    toggle.setAttribute("aria-pressed", String(isDark));
    toggle.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    toggle.title = isDark ? "Light mode" : "Dark mode";
    const label = toggle.querySelector("[data-theme-label]");
    if (label) label.textContent = isDark ? "Light" : "Dark";
  }
  return next;
}

export function initTheme() {
  const theme = applyTheme(resolveTheme());
  const toggle = document.querySelector("#themeToggle");
  toggle?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
    if (localStorage.getItem(THEME_KEY)) return;
    applyTheme(event.matches ? "dark" : "light");
  });
  return theme;
}

export function themeBootScript() {
  return `(function(){try{var k='pulsewatch-theme';var s=localStorage.getItem(k);var t=(s==='light'||s==='dark')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch(e){document.documentElement.dataset.theme='light';}})();`;
}
