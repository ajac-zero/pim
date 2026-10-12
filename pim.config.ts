import { assistant } from "./src/extensions/assistant";
import { definePimConfig } from "./src/extensions/define";

/**
 * This deployment's extensions: the Pims people can build on, and the widgets
 * their dashboards show. Add an extension's import to the list and deploy;
 * take one out and nobody has it anymore. Pims built on a Pim that's gone
 * keep their name and the person's own instructions. See docs/extensions.md.
 *
 * Pim's own abilities (goals, schedules, memory, artifacts) are always
 * installed, with their widgets: they aren't listed here.
 */
export default definePimConfig({
	extensions: [assistant],
	// The Pim every new account starts with, and that new Pims build on: `<extension>/<pim>`, or null for none.
	defaultPim: "pim.assistant/pim",
});
