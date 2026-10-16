import { bundledThemes, type ThemeRegistration } from "shiki";
import { describe, expect, it } from "vitest";
import { codeThemeLoaders } from "~/lib/themes";

describe("Tokyo Night's light code theme", () => {
  // A Shiki update can add colors to Tokyo Night; unmapped ones would show
  // the dark theme's pale colors on the light canvas.
  it("recolors every token color of the dark theme", async () => {
    const night = (await bundledThemes["tokyo-night"]()).default;
    const loader = codeThemeLoaders().find(
      (theme): theme is () => Promise<ThemeRegistration> =>
        typeof theme === "function",
    );
    const day = await loader?.();

    const nightColors = new Set(
      night.tokenColors?.map((rule) => rule.settings.foreground?.toLowerCase()),
    );
    const leftovers = day?.tokenColors
      ?.map((rule) => rule.settings.foreground?.toLowerCase())
      .filter((color) => color && nightColors.has(color));
    expect(day?.type).toBe("light");
    expect(leftovers).toEqual([]);
  });
});
