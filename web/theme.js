(function () {
  const THEME_KEY = "algolens-theme";
  const root = document.documentElement;

  function storedTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (_) {
      return null;
    }
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (_) {
      // Ignore storage failures; the toggle should still work for this page.
    }
  }

  function setTheme(theme, persist = false) {
    const nextTheme = theme === "light" ? "light" : "dark";
    root.dataset.theme = nextTheme;
    root.style.colorScheme = nextTheme;

    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      const isLight = nextTheme === "light";
      button.textContent = isLight ? "dark mode" : "light mode";
      button.setAttribute("aria-pressed", String(isLight));
      button.setAttribute("aria-label", `Switch to ${isLight ? "dark" : "light"} mode`);
      button.title = `Switch to ${isLight ? "dark" : "light"} mode`;
    });

    if (persist) saveTheme(nextTheme);
  }

  setTheme(storedTheme());

  window.addEventListener("DOMContentLoaded", () => {
    setTheme(root.dataset.theme);

    document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
      button.addEventListener("click", () => {
        setTheme(root.dataset.theme === "light" ? "dark" : "light", true);
      });
    });
  });
})();
