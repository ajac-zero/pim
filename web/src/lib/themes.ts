import {
  type BundledTheme,
  bundledThemes,
  type ThemeRegistration,
} from "shiki";

/**
 * The color themes a person can pick; the first is the default. A theme only
 * changes colors: its tokens for light and dark mode live in
 * src/styles/themes/<id>.css under `[data-theme="<id>"]` (the default's on
 * :root), next to the rules that color code with its Shiki themes below.
 */
export const themes = [
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    background: { light: "#e6e7ed", dark: "#1a1b26" },
    code: { light: "tokyo-night-day", dark: "tokyo-night" },
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    background: { light: "#eff1f5", dark: "#1e1e2e" },
    code: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
  },
  {
    id: "solarized",
    name: "Solarized",
    background: { light: "#fdf6e3", dark: "#002b36" },
    code: { light: "solarized-light", dark: "solarized-dark" },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    background: { light: "#fbf1c7", dark: "#282828" },
    code: { light: "gruvbox-light-medium", dark: "gruvbox-dark-medium" },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    background: { light: "#faf4ed", dark: "#191724" },
    code: { light: "rose-pine-dawn", dark: "rose-pine" },
  },
  {
    id: "one",
    name: "One",
    background: { light: "#fafafa", dark: "#282c34" },
    code: { light: "one-light", dark: "one-dark-pro" },
  },
  {
    id: "everforest",
    name: "Everforest",
    background: { light: "#fdf6e3", dark: "#2d353b" },
    code: { light: "everforest-light", dark: "everforest-dark" },
  },
  {
    id: "nord",
    name: "Nord",
    background: { light: "#e5e9f0", dark: "#2e3440" },
    code: { light: "nord-light", dark: "nord" },
  },
  {
    id: "dracula",
    name: "Dracula",
    background: { light: "#fffbeb", dark: "#282a36" },
    code: { light: "alucard", dark: "dracula" },
  },
  {
    id: "ayu",
    name: "Ayu",
    background: { light: "#fcfcfc", dark: "#242936" },
    code: { light: "ayu-light", dark: "ayu-mirage" },
  },
  // Parody themes: affectionate nods to the apps that inspired Pim's design.
  {
    id: "gronk",
    name: "Gronk",
    background: { light: "#fafafa", dark: "#161616" },
    code: { light: "github-light-default", dark: "github-dark-default" },
  },
  {
    id: "moose",
    name: "Moose",
    background: { light: "#f3f4f5", dark: "#181819" },
    code: { light: "light-plus", dark: "dark-plus" },
  },
] as const satisfies readonly {
  id: string;
  name: string;
  /** The canvas per mode, for the browser's theme-color. */
  background: { light: string; dark: string };
  /** Shiki themes for code blocks: bundled, or one of `recoloredCodeThemes`. */
  code: { light: string; dark: string };
}[];

export type ColorTheme = (typeof themes)[number];
export type ColorThemeId = ColorTheme["id"];

export const defaultTheme: ColorTheme = themes[0];

export const findTheme = (id: string | null): ColorTheme =>
  themes.find((theme) => theme.id === id) ?? defaultTheme;

/**
 * Shiki colors code for every theme and mode at once, as CSS variables named
 * `--shiki-<id>-<mode>`; each theme's CSS file picks its own.
 */
export const codeThemes: Record<string, string> = Object.fromEntries(
  themes.flatMap((theme) => [
    [`${theme.id}-light`, theme.code.light],
    [`${theme.id}-dark`, theme.code.dark],
  ]),
);

/**
 * Light code themes Shiki doesn't ship, made by recoloring a bundled dark one:
 * each of its colors maps to the light palette's counterpart, darkened where
 * needed to stay readable on the light canvas.
 */
export const recoloredCodeThemes = {
  // Tokyo Night "Day".
  "tokyo-night-day": {
    base: "tokyo-night",
    background: "#e6e7ed",
    foreground: "#343b58",
    colors: {
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
    },
  },
  // Nord's Snow Storm palette with Polar Night text.
  "nord-light": {
    base: "nord",
    background: "#e5e9f0",
    foreground: "#2e3440",
    colors: {
      "#d8dee9ff": "#2e3440",
      "#616e88": "#4c566a",
      "#ebcb8b": "#806121",
      "#81a1c1": "#4a6b8c",
      "#b48ead": "#805578",
      "#8fbcbb": "#3b706f",
      "#88c0d0": "#356d7c",
      "#d8dee9": "#2e3440",
      "#bf616a": "#a13f49",
      "#a3be8c": "#526f3c",
      "#5e81ac": "#4a6b8c",
      "#eceff4": "#2e3440",
      "#d08770": "#99523b",
    },
  },
  // Alucard, Dracula's official light palette.
  alucard: {
    base: "dracula",
    background: "#fffbeb",
    foreground: "#1f1f1f",
    colors: {
      "#bd93f9": "#644ac9",
      "#6272a4": "#6c664b",
      "#50fa7b": "#14710a",
      "#ff5555": "#cb3a2a",
      "#ffb86c": "#a34d14",
      "#f8f8f2": "#1f1f1f",
      "#f1fa8c": "#846e15",
      "#8be9fd": "#036a96",
      "#ff79c6": "#a3144d",
      "#e9f284": "#846e15",
      "#8be9fe": "#036a96",
    },
  },
} satisfies Record<
  string,
  {
    base: BundledTheme;
    background: string;
    foreground: string;
    colors: Record<string, string>;
  }
>;

type RecoloredName = keyof typeof recoloredCodeThemes;

export async function loadRecolored(
  name: RecoloredName,
): Promise<ThemeRegistration> {
  const { base, background, foreground, colors } = recoloredCodeThemes[name];
  const dark = (await bundledThemes[base]()).default;
  const light = (color: string | undefined) =>
    color && (colors[color.toLowerCase() as keyof typeof colors] ?? color);
  return {
    ...dark,
    name,
    type: "light",
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
    },
    tokenColors: dark.tokenColors?.map((rule) => ({
      ...rule,
      settings: {
        ...rule.settings,
        foreground: light(rule.settings.foreground),
      },
    })),
  };
}

/** What the highlighter loads: every theme above, by name or by loader. */
export const codeThemeLoaders = () =>
  [...new Set(Object.values(codeThemes))].map((name) =>
    name in recoloredCodeThemes
      ? () => loadRecolored(name as RecoloredName)
      : (name as BundledTheme),
  );
