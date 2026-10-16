import {
  type BundledTheme,
  bundledThemes,
  type ThemeRegistration,
} from "shiki";
import {
  type CodeTheme,
  codeKey,
  type RecoloredCodeTheme,
  type ThemeList,
} from "../../../src/themes";

/**
 * The color themes a person can pick come from the Pim's extensions (see
 * src/themes.ts): the Worker serves their tokens as /api/themes.css, which
 * index.html loads before the app draws, and lists them at /api/themes.
 */
export type ColorTheme = ThemeList["themes"][number];

let list: Promise<ThemeList> | undefined;

/** This Pim's color themes, fetched once. */
export function loadThemes(): Promise<ThemeList> {
  list ??= fetch("/api/themes").then(async (response) => {
    if (!response.ok)
      throw new Error(`Couldn't load the color themes (${response.status})`);
    return (await response.json()) as ThemeList;
  });
  return list;
}

const shipped = (code: CodeTheme) =>
  (typeof code === "string" ? code : code.base) in bundledThemes;

let code:
  | Promise<{
      names: Record<string, string>;
      loaders: (BundledTheme | (() => Promise<ThemeRegistration>))[];
    }>
  | undefined;

/**
 * Shiki colors code for every theme and mode at once, as CSS variables named
 * `--shiki-<id>-<mode>`; the stylesheet's `.shiki-token` rules pick the
 * active one. `names` are the Shiki themes by those keys, and `loaders` what
 * the highlighter loads. A theme Shiki doesn't ship is left out, so the
 * others still color code.
 */
export function loadCodeThemes() {
  code ??= loadThemes().then(({ themes }) => {
    const names: Record<string, string> = {};
    const loaders = new Map<
      string,
      BundledTheme | (() => Promise<ThemeRegistration>)
    >();
    for (const theme of themes) {
      for (const mode of ["light", "dark"] as const) {
        const spec = theme.code[mode];
        const key = codeKey(theme.id, mode);
        if (!shipped(spec)) {
          console.error(`Shiki doesn't ship the code theme of ${key}`);
          continue;
        }
        const name = typeof spec === "string" ? spec : `recolored-${key}`;
        names[key] = name;
        loaders.set(
          name,
          typeof spec === "string"
            ? (spec as BundledTheme)
            : () => loadRecolored(name, spec, mode),
        );
      }
    }
    return { names, loaders: [...loaders.values()] };
  });
  return code;
}

/** A recolored code theme, for `mode`: its base's rules, in its colors. */
export async function loadRecolored(
  name: string,
  { base, background, foreground, colors }: RecoloredCodeTheme,
  mode: "light" | "dark",
): Promise<ThemeRegistration> {
  const original = (await bundledThemes[base as BundledTheme]()).default;
  const recolor = (color: string | undefined) =>
    color && (colors[color.toLowerCase()] ?? color);
  return {
    ...original,
    name,
    type: mode,
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
    },
    tokenColors: original.tokenColors?.map((rule) => ({
      ...rule,
      settings: {
        ...rule.settings,
        foreground: recolor(rule.settings.foreground),
      },
    })),
  };
}
