import { definePimExtension } from "./define";
import { GITHUB_LOGO, HUGGING_FACE_LOGO, LINEAR_LOGO, NOTION_LOGO } from "./logos";

/**
 * Popular apps with remote MCP servers of their own, which each person
 * connects with their own account. GitHub's sign-in doesn't let apps
 * register themselves, so it's offered once the deployment registers an
 * OAuth app at github.com/settings/developers, with this Pim's
 * `/mcp/callback` as its callback URL, and sets GITHUB_CLIENT_ID and
 * GITHUB_CLIENT_SECRET.
 */
export const popularApps = definePimExtension({
	id: "pim.apps",
	name: "Popular apps",
	description: "Apps people use every day, each connected with your own account.",
	apps: [
		{
			id: "github",
			name: "GitHub",
			description: "Repositories, issues, pull requests and Actions.",
			url: "https://api.githubcopilot.com/mcp/",
			icon: GITHUB_LOGO,
			client: { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
		},
		{
			id: "linear",
			name: "Linear",
			description: "Issues, projects and cycles in your workspace.",
			url: "https://mcp.linear.app/mcp",
			icon: LINEAR_LOGO,
		},
		{
			id: "notion",
			name: "Notion",
			description: "Search, read and write your pages and databases.",
			url: "https://mcp.notion.com/mcp",
			icon: NOTION_LOGO,
		},
		{
			id: "hugging-face",
			name: "Hugging Face",
			description: "Search models, datasets, papers and Spaces on the Hub.",
			url: "https://huggingface.co/mcp",
			icon: HUGGING_FACE_LOGO,
		},
	],
});
