import type { Theme } from "../themes";
import { ayu } from "./ayu";
import { catppuccin } from "./catppuccin";
import { dracula } from "./dracula";
import { everforest } from "./everforest";
import { gronk } from "./gronk";
import { gruvbox } from "./gruvbox";
import { moose } from "./moose";
import { nord } from "./nord";
import { one } from "./one";
import { pixel } from "./pixel";
import { rosePine } from "./rose-pine";
import { solarized } from "./solarized";
import { tokyoNight } from "./tokyo-night";

/** Pim's own color themes as data, in the order the app lists them: each theme's file holds its colors, and the web app holds none of its own. */
export const pimThemes: Theme[] = [
	tokyoNight,
	pixel,
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
];
