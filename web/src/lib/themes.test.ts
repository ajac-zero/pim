import { bundledThemes } from "shiki";
import { describe, expect, it } from "vitest";
import { loadRecolored, recoloredCodeThemes } from "~/lib/themes";

describe("recolored light code themes", () => {
  // A Shiki update can add colors to a dark theme; unmapped ones would show
  // its pale colors on the light canvas.
  it.each(
    Object.keys(recoloredCodeThemes) as (keyof typeof recoloredCodeThemes)[],
  )("%s recolors every token color of its dark theme", async (name) => {
    const { base } = recoloredCodeThemes[name];
    const dark = (await bundledThemes[base]()).default;
    const light = await loadRecolored(name);

    const darkColors = new Set(
      dark.tokenColors?.map((rule) => rule.settings.foreground?.toLowerCase()),
    );
    const leftovers = light.tokenColors
      ?.map((rule) => rule.settings.foreground?.toLowerCase())
      .filter((color) => color && darkColors.has(color));
    expect(light.type).toBe("light");
    expect(leftovers).toEqual([]);
  });
});
