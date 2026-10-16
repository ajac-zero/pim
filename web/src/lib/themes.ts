import {
  type BundledTheme,
  bundledThemes,
  type ThemeRegistration,
} from "shiki";

/**
 * The color themes a person can pick; the first is the default. A theme only
 * changes colors: its tokens for light and dark mode live in
 * src/styles/app.css under `[data-theme="<id>"]` (the default's on :root),
 * next to the rules that color code with its Shiki themes below.
 */
export const themes = [
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    light: { background: "#e6e7ed", primary: "#2e6bd6" },
    dark: { background: "#1a1b26", primary: "#7aa2f7" },
    code: { light: "tokyo-night-day", dark: "tokyo-night" },
  },
  // Parody themes: affectionate nods to the apps that inspired Pim's design.
  {
    id: "gronk-bot",
    name: "Gronk Bot",
    light: { background: "#fafafa", primary: "#0a0a0a" },
    dark: { background: "#161616", primary: "#f2f2f2" },
    code: { light: "github-light-default", dark: "github-dark-default" },
  },
] as const satisfies readonly {
  id: string;
  name: string;
  /** For the picker's swatch and the browser's theme-color. */
  light: { background: string; primary: string };
  dark: { background: string; primary: string };
  /** Shiki themes for code blocks: bundled, or one of `customCodeThemes`. */
  code: { light: string; dark: string };
}[];

export type ColorTheme = (typeof themes)[number];
export type ColorThemeId = ColorTheme["id"];

export const defaultTheme: ColorTheme = themes[0];

export const findTheme = (id: string | null): ColorTheme =>
  themes.find((theme) => theme.id === id) ?? defaultTheme;

/**
 * Shiki colors code for every theme and mode at once, as CSS variables named
 * `--shiki-<id>-<mode>`; app.css picks the active one.
 */
export const codeThemes: Record<string, string> = Object.fromEntries(
  themes.flatMap((theme) => [
    [`${theme.id}-light`, theme.code.light],
    [`${theme.id}-dark`, theme.code.dark],
  ]),
);

/** What the highlighter loads: every theme above, by name or by loader. */
export const codeThemeLoaders = () => {
  const custom = { "tokyo-night-day": tokyoNightDay };
  return [...new Set(Object.values(codeThemes))].map(
    (name) => custom[name as keyof typeof custom] ?? (name as BundledTheme),
  );
};

/**
 * Shiki only ships Tokyo Night's dark variant, so the light one recolors it:
 * each Night color maps to its "Day" counterpart, darkened where needed to
 * stay readable on the light canvas.
 */
const NIGHT_TO_DAY: Record<string, string> = {
  "#c0caf5": "#343b58",
  "#c0cefc": "#343b58",
  "#a9b1d6": "#4c5372",
  "#9aa5ce": "#4c5372",
  "#d9d4cd": "#4c5372",
  "#bb9af7": "#9854f1",
  "#9d7cd8": "#7847bd",
  "#b267e6": "#7847bd",
  "#ba3c97": "#b02a83",
  "#7dcfff": "#007197",
  "#0db9d7": "#0f6f8c",
  "#2ac3de": "#188092",
  "#61bdf2": "#006a83",
  "#89ddff": "#006a83",
  "#b4f9f8": "#2e5857",
  "#7aa2f7": "#2e6bd6",
  "#6d91de": "#2e6bd6",
  "#9abdf5": "#3d5ea8",
  "#6183bb": "#4a5f9e",
  "#f7768e": "#d6264f",
  "#de5971": "#c64343",
  "#ff5370": "#c64343",
  "#fc7b7b": "#c64343",
  "#db4b4b": "#c64343",
  "#914c54": "#c64343",
  "#ff9e64": "#b15c00",
  "#e0af68": "#8c6c3e",
  "#ffdb69": "#8c6c3e",
  "#9ece6a": "#587539",
  "#73daca": "#387068",
  "#41a6b5": "#2f7f8c",
  "#449dab": "#2f7f8c",
  "#51597d": "#7a80a0",
  "#5a638c": "#7a80a0",
  "#646e9c": "#7a80a0",
  "#4e5579": "#7a80a0",
  "#747ca1": "#7a80a0",
};

async function tokyoNightDay(): Promise<ThemeRegistration> {
  const night = (await bundledThemes["tokyo-night"]()).default;
  const day = (color: string | undefined) =>
    color && (NIGHT_TO_DAY[color.toLowerCase()] ?? color);
  return {
    ...night,
    name: "tokyo-night-day",
    displayName: "Tokyo Night Day",
    type: "light",
    colors: { "editor.background": "#e6e7ed", "editor.foreground": "#343b58" },
    tokenColors: night.tokenColors?.map((rule) => ({
      ...rule,
      settings: { ...rule.settings, foreground: day(rule.settings.foreground) },
    })),
  };
}
