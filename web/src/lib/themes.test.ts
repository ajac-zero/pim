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
const recolored = Object.values(modules)
  .flatMap((module) => Object.values(module))
  .flatMap((theme) =>
    (["light", "dark"] as const).flatMap((mode) => {
      const code = theme.code[mode];
      return typeof code === "string"
        ? []
        : [[`${theme.id} ${mode}`, code, mode] as const];
    }),
  );

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
