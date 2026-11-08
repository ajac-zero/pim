import { bundledThemes } from "shiki";
import { describe, expect, it } from "vitest";
import { loadRecolored } from "~/lib/themes";
import type { RecoloredCodeTheme, Theme } from "../../../src/themes";

// Pim's own themes, one per file; the extension that lists them is server code.
const modules = import.meta.glob<Record<string, Theme>>(
  [
    "../../../src/extensions/themes/*.ts",
    "!../../../src/extensions/themes/index.ts",
  ],
  { eager: true },
);
const themes = Object.values(modules).flatMap((module) =>
  Object.values(module),
);
const recolored = themes.flatMap((theme) =>
  (["light", "dark"] as const).flatMap((mode) => {
    const code = theme.code[mode];
    return typeof code === "string"
      ? []
      : [[`${theme.id} ${mode}`, code, mode] as const];
  }),
);

/** Relative luminance for the hex and neutral OKLCH colors in Pim's surfaces. */
function luminance(color: string): number {
  const neutral = /^oklch\(([\d.]+) 0 0\)$/.exec(color);
  if (neutral) return Number(neutral[1]) ** 3;
  const chromatic = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  if (chromatic) {
    const [lightness, chroma, hue] = chromatic.slice(1).map(Number) as [
      number,
      number,
      number,
    ];
    const a = chroma * Math.cos((hue * Math.PI) / 180);
    const b = chroma * Math.sin((hue * Math.PI) / 180);
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const n = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return (
      0.2126 * (4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * n) +
      0.7152 * (-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * n) +
      0.0722 * (-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * n)
    );
  }
  expect(color).toMatch(/^#[\da-f]{6}$/i);
  return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const channel =
      Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    const linear =
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * weight;
  }, 0);
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("user message surfaces", () => {
  it.each(themes)(
    "$name keeps bubbles quiet and text readable in both modes",
    (theme) => {
      for (const mode of ["light", "dark"] as const) {
        const colors = theme[mode];
        const background = colors.bubble ?? colors.secondary;
        const foreground =
          colors["bubble-foreground"] ?? colors["secondary-foreground"];
        expect(
          contrast(foreground, background),
          `${mode} text`,
        ).toBeGreaterThanOrEqual(4.5);
        // A reading surface stays near the canvas instead of becoming a bright primary action.
        expect(
          contrast(background, colors.background),
          `${mode} surface`,
        ).toBeLessThanOrEqual(2);
      }
    },
  );
});

// The lifecycle and health chips sit on `muted` and say their state in words:
// `text-foreground`, whatever the tone.
describe("status chips", () => {
  it.each(themes)("$name keeps chip text readable in both modes", (theme) => {
    for (const mode of ["light", "dark"] as const) {
      const colors = theme[mode];
      expect(
        contrast(colors.foreground, colors.muted),
        `${mode} text`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

// Rows, filters and buttons draw their focus ring in the `ring` color at full
// strength, so it must stand out from the page by the 3:1 non-text minimum.
describe("focus ring", () => {
  it.each(themes)(
    "$name's ring stands out from the page in both modes",
    (theme) => {
      for (const mode of ["light", "dark"] as const) {
        const colors = theme[mode];
        expect(
          contrast(colors.ring, colors.background),
          `${mode} ring`,
        ).toBeGreaterThanOrEqual(3);
      }
    },
  );
});

describe("recolored code themes", () => {
  it("finds Pim's own", () => {
    expect(recolored.length).toBeGreaterThan(0);
  });

  // A Shiki update can add colors to a base theme; unmapped ones would show
  // its colors on the other mode's canvas.
  it.each(recolored)(
    "%s recolors every token color of its base",
    async (name, code: RecoloredCodeTheme, mode) => {
      const original = (
        await bundledThemes[code.base as keyof typeof bundledThemes]()
      ).default;
      const theme = await loadRecolored(name, code, mode);

      const originalColors = new Set(
        original.tokenColors?.map((rule) =>
          rule.settings.foreground?.toLowerCase(),
        ),
      );
      const leftovers = theme.tokenColors
        ?.map((rule) => rule.settings.foreground?.toLowerCase())
        .filter((color) => color && originalColors.has(color));
      expect(theme.type).toBe(mode);
      expect(leftovers).toEqual([]);
    },
  );
});
