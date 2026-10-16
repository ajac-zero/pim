import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { type ColorTheme, loadThemes } from "~/lib/themes";
import type { ThemeList } from "../../../src/themes";

export type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  /** Light, dark or following the system: the mode. */
  preference: ThemePreference;
  /** The mode actually applied right now. */
  resolved: "light" | "dark";
  setPreference: (theme: ThemePreference) => void;
  /** This Pim's color themes, Pim's own and its extensions', once loaded. */
  themes: readonly ColorTheme[];
  /**
   * The color theme, which has its own light and dark palettes: the one
   * picked, or the Pim's default when none was or it's gone. Undefined until
   * the themes load.
   */
  colorTheme: ColorTheme | undefined;
  setColorTheme: (id: string) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  preference: "system",
  resolved: "light",
  setPreference: () => {},
  themes: [],
  colorTheme: undefined,
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
  const [list, setList] = useState<ThemeList | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  // Sync from storage after hydration (the root inline script already applied
  // the right class and theme, so there is no flash).
  useEffect(() => {
    const pref = readPreference();
    setPreferenceState(pref);
    setResolved(pref === "system" ? systemTheme() : pref);
    setPicked(window.localStorage.getItem(COLOR_THEME_KEY));
    loadThemes().then(setList, (error) => console.error(error));
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

  // A theme that's gone matches no rule in the stylesheet, which then shows
  // the default. The browser's own UI (mobile address bar, installed app
  // title bar) follows the canvas.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the canvas changes with the mode, which `resolved` follows
  useEffect(() => {
    const root = document.documentElement;
    if (picked) root.dataset.theme = picked;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        getComputedStyle(root).getPropertyValue("--background").trim(),
      );
  }, [picked, resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    const applied = next === "system" ? systemTheme() : next;
    setResolved(applied);
    document.documentElement.classList.toggle("dark", applied === "dark");
  }, []);

  const setColorTheme = useCallback((id: string) => {
    window.localStorage.setItem(COLOR_THEME_KEY, id);
    setPicked(id);
  }, []);

  const value = useMemo(() => {
    const themes = list?.themes ?? [];
    const colorTheme =
      themes.find((theme) => theme.id === picked) ??
      themes.find((theme) => theme.id === list?.default);
    return {
      preference,
      resolved,
      setPreference,
      themes,
      colorTheme,
      setColorTheme,
    };
  }, [preference, resolved, setPreference, list, picked, setColorTheme]);

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
