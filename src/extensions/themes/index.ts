import { definePimExtension } from "../define";
import { ayu } from "./ayu";
import { catppuccin } from "./catppuccin";
import { dracula } from "./dracula";
import { everforest } from "./everforest";
import { gronk } from "./gronk";
import { gruvbox } from "./gruvbox";
import { moose } from "./moose";
import { nord } from "./nord";
import { one } from "./one";
import { rosePine } from "./rose-pine";
import { solarized } from "./solarized";
import { tokyoNight } from "./tokyo-night";

/**
 * Pim's own color themes: an extension like any other, always installed, so
 * every deployment has them. Each theme's file holds its colors; the web app
 * holds no colors of its own.
 */
export const themes = definePimExtension({
	id: "pim.themes",
	name: "Themes",
	description: "Pim's own color themes.",
	themes: [
		tokyoNight,
		catppuccin,
		solarized,
		gruvbox,
		rosePine,
		one,
		everforest,
		nord,
		dracula,
		ayu,
		// Parody themes: affectionate nods to the apps that inspired Pim's design.
		gronk,
		moose,
	],
});
