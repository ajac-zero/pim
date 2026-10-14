import { assistant } from "./src/extensions/assistant";
import { definePimConfig } from "./src/extensions/define";

/**
 * This deployment's extensions: the bases people's Pims build on, and the widgets
 * their dashboards show. Add an extension's import to the list and deploy;
 * take one out and nobody has it anymore. Pims built on a base that's gone
 * keep their name and the person's own instructions. See docs/extensions.md.
 *
 * Pim's own abilities (goals, schedules, memory, artifacts) are always
 * installed, with their widgets: they aren't listed here.
 */
export default definePimConfig({
	extensions: [assistant],
	// The base every new account's first Pim builds on, and new Pims by default: `<extension>/<base>`, or null for none.
	defaultBase: "pim.assistant/pim",
});
