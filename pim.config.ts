import { assistant } from "./src/extensions/assistant";
import { definePimConfig } from "./src/extensions/define";

/**
 * This deployment's extensions: the blueprints people's agents build on, and the widgets
 * their dashboards show. Add an extension's import to the list and deploy;
 * take one out and nobody has it anymore. Agents built on a blueprint that's gone
 * keep their name and the person's own instructions. See docs/extensions.md.
 *
 * Pim's own abilities (goals, schedules, memory, artifacts) are always
 * installed, with their widgets: they aren't listed here.
 */
export default definePimConfig({
	extensions: [assistant],
	// The blueprint every new account's first agent builds on, and new agents by default: `<extension>/<blueprint>`, or null for none.
	defaultBlueprint: "pim.assistant/pim",
});
