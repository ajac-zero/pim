import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type ColorTheme,
  type ColorThemeId,
  defaultTheme,
  findTheme,
} from "~/lib/themes";

export type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  /** Light, dark or following the system: the mode. */
  preference: ThemePreference;
  /** The mode actually applied right now. */
  resolved: "light" | "dark";
  setPreference: (theme: ThemePreference) => void;
  /** The color theme, which has its own light and dark palettes. */
  colorTheme: ColorTheme;
  setColorTheme: (id: ColorThemeId) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  resolved: "light",
  setPreference: () => {},
  colorTheme: defaultTheme,
  setColorTheme: () => {},
});

// Both keys are also read by the inline script in index.html.
const STORAGE_KEY = "pim-theme";
const COLOR_THEME_KEY = "pim-color-theme";

function systemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(defaultTheme);

  // Sync from storage after hydration (the root inline script already applied
  // the right class and theme, so there is no flash).
  useEffect(() => {
    const pref = readPreference();
    setPreferenceState(pref);
    setResolved(pref === "system" ? systemTheme() : pref);
    setColorThemeState(findTheme(window.localStorage.getItem(COLOR_THEME_KEY)));
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (readPreference() === "system") {
        const next = systemTheme();
        setResolved(next);
        document.documentElement.classList.toggle("dark", next === "dark");
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // The browser's own UI (mobile address bar, installed app title bar)
  // follows the canvas.
  useEffect(() => {
    document.documentElement.dataset.theme = colorTheme.id;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", colorTheme[resolved].background);
  }, [colorTheme, resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    const applied = next === "system" ? systemTheme() : next;
    setResolved(applied);
    document.documentElement.classList.toggle("dark", applied === "dark");
  }, []);

  const setColorTheme = useCallback((id: ColorThemeId) => {
    window.localStorage.setItem(COLOR_THEME_KEY, id);
    setColorThemeState(findTheme(id));
  }, []);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, colorTheme, setColorTheme }),
    [preference, resolved, setPreference, colorTheme, setColorTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
