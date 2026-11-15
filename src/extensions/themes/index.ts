import { pimThemes } from "@pim/shared/theme-data/index";
import { definePimExtension } from "../define";

/**
 * Pim's own color themes: an extension like any other, always installed, so
 * every deployment has them. Each theme's file holds its colors; the web app
 * holds no colors of its own.
 */
export const themes = definePimExtension({
	id: "pim.themes",
	name: "Themes",
	description: "Pim's own color themes.",
	themes: pimThemes,
});
