import type { Theme } from "../../themes";
import { tokyoNight } from "./tokyo-night";

/** Pim's pixel wordmark carried through its typography and outline icons. */
export const pixel: Theme = {
	...tokyoNight,
	id: "pixel",
	name: "Pixel",
	fonts: { ui: "pixel", code: "pixel" },
	icons: "pixel",
};
