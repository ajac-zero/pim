/**
 * Themes, which extensions bring: a value for every color token the web
 * app's components use (web/src/styles/app.css) in light mode and in dark
 * mode, and the Shiki themes that color code in each. Themes are data: the
 * Worker turns the deployment's into one stylesheet, `/api/themes.css`, and
 * lists them at `/api/themes` for Settings → Appearance. No extension code
 * runs in the browser.
 *
 * The web app imports this module too, so it imports nothing of the server's.
 */

/** Every token a theme gives a value, in each mode. */
export const THEME_TOKENS = [
	"background",
	"foreground",
	"card",
	"card-foreground",
	"popover",
	"popover-foreground",
	"primary",
	"primary-foreground",
	"secondary",
	"secondary-foreground",
	"muted",
	"muted-foreground",
	"accent",
	"accent-foreground",
	"destructive",
	"destructive-foreground",
	"link",
	"success",
	"border",
	"input",
	"ring",
	"chart-1",
	"chart-2",
	"chart-3",
	"chart-4",
	"chart-5",
	"sidebar",
	"sidebar-foreground",
	"sidebar-primary",
	"sidebar-primary-foreground",
	"sidebar-accent",
	"sidebar-accent-foreground",
	"sidebar-border",
	"sidebar-ring",
	"agent-gray",
	"agent-red",
	"agent-orange",
	"agent-amber",
	"agent-green",
	"agent-teal",
	"agent-blue",
	"agent-indigo",
	"agent-violet",
	"agent-pink",
] as const;

/** Tokens a theme may leave out: user message bubbles follow the secondary surface unless it sets them. */
const OPTIONAL_TOKENS = ["bubble", "bubble-foreground"] as const;

/** One mode's colors: any CSS color, by token. */
export type ThemeColors = Readonly<Record<(typeof THEME_TOKENS)[number], string>> &
	Readonly<Partial<Record<(typeof OPTIONAL_TOKENS)[number], string>>>;

/**
 * A code theme Shiki doesn't ship, made by recoloring one it does, such as a
 * light one from a dark one: each of the base's colors maps to its
 * counterpart, and colors it doesn't map stay as they are.
 */
export type RecoloredCodeTheme = {
	/** A theme Shiki bundles. */
	readonly base: string;
	readonly background: string;
	readonly foreground: string;
	/** The base's colors, lowercase, to theirs. */
	readonly colors: Readonly<Record<string, string>>;
};

/** A theme Shiki bundles, by name, or a recolored one. */
export type CodeTheme = string | RecoloredCodeTheme;

/** Bundled typography and icon styles; themes select assets, not browser code. */
export type ThemeFont = "system" | "pixel";
export type ThemeIcons = "lucide" | "pixel";

const FONTS = {
	ui: {
		system: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
		pixel: '"Pixeloid Sans", ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
	},
	code: {
		system: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
		pixel: '"Pixeloid Mono", ui-monospace, monospace',
	},
} as const;

export type Theme = {
	/** Unique among every extension's themes: lowercase letters, digits and hyphens. Stored in people's browsers: don't rename it. */
	readonly id: string;
	readonly name: string;
	readonly light: ThemeColors;
	readonly dark: ThemeColors;
	/** Omitted roles keep the system fonts, even inside another theme's preview. */
	readonly fonts?: { readonly ui?: ThemeFont; readonly code?: ThemeFont };
	/** Utility and named agent icons. Images, emoji and brand logos keep their identity. */
	readonly icons?: ThemeIcons;
	/** What colors code blocks in each mode. */
	readonly code: { readonly light: CodeTheme; readonly dark: CodeTheme };
};

/** The deployment's themes as the web app gets them, at `/api/themes`. */
export type ThemeList = {
	/** What people see until they pick another, and when the one they picked is gone. */
	readonly default: string;
	readonly themes: readonly (Pick<Theme, "id" | "name" | "code" | "fonts" | "icons"> & { readonly extension: string })[];
};

/** Shiki colors code for every theme and mode at once, in CSS variables named `--shiki-<key>`. */
export const codeKey = (id: string, mode: "light" | "dark") => `${id}-${mode}`;

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOKENS = new Set<string>([...THEME_TOKENS, ...OPTIONAL_TOKENS]);

/**
 * The deployment's themes, checked once: ids are well formed and unique, each
 * mode has every token and no others, and the default exists. A mistake fails
 * here, loudly, instead of drawing the app in missing colors.
 */
export class PimThemes {
	readonly #themes: { extension: string; theme: Theme }[] = [];

	constructor(
		extensions: readonly { readonly id: string; readonly themes?: readonly Theme[] }[],
		readonly defaultTheme: string,
	) {
		const ids = new Map<string, string>();
		for (const extension of extensions) {
			for (const theme of extension.themes ?? []) {
				if (!ID.test(theme.id)) throw new Error(`${extension.id}'s theme id ${JSON.stringify(theme.id)} must be lowercase letters, digits and hyphens`);
				const owner = ids.get(theme.id);
				if (owner !== undefined) throw new Error(`${extension.id} brings a theme called ${theme.id}, which ${owner} already has`);
				ids.set(theme.id, extension.id);
				for (const role of ["ui", "code"] as const) {
					const font = theme.fonts?.[role];
					if (font !== undefined && !Object.hasOwn(FONTS[role], font)) throw new Error(`${theme.id}'s ${role} font ${JSON.stringify(font)} isn't bundled`);
				}
				if (theme.icons !== undefined && theme.icons !== "lucide" && theme.icons !== "pixel") throw new Error(`${theme.id}'s icon set ${JSON.stringify(theme.icons)} isn't bundled`);
				for (const mode of ["light", "dark"] as const) {
					const missing = THEME_TOKENS.filter((token) => !Object.hasOwn(theme[mode], token));
					const unknown = Object.keys(theme[mode]).filter((token) => !TOKENS.has(token));
					if (missing.length > 0 || unknown.length > 0) {
						throw new Error(`${theme.id}'s ${mode} colors ${[...missing.map((token) => `lack ${token}`), ...unknown.map((token) => `have an unknown ${token}`)].join(", ")}`);
					}
				}
				this.#themes.push({ extension: extension.id, theme });
			}
		}
		if (!ids.has(defaultTheme)) throw new Error(`The default theme ${defaultTheme} isn't in any installed extension`);
	}

	list(): ThemeList {
		return {
			default: this.defaultTheme,
			themes: this.#themes.map(({ extension, theme }) => ({ id: theme.id, name: theme.name, extension, code: theme.code, fonts: theme.fonts, icons: theme.icons })),
		};
	}

	/**
	 * Every theme's tokens under `[data-theme="<id>"]` (light) and
	 * `[data-theme="<id>"].dark`, with the rules that pick its code colors.
	 * The default comes first and also sits on `:root` and `.dark`, so a page
	 * with no theme, or one that's gone, gets it, and the others win over it.
	 */
	stylesheet(): string {
		const ordered = [...this.#themes].sort((a, b) => Number(b.theme.id === this.defaultTheme) - Number(a.theme.id === this.defaultTheme));
		return ordered
			.map(({ theme }) => {
				const own = `[data-theme="${theme.id}"]`;
				const isDefault = theme.id === this.defaultTheme;
				const rule = (selectors: string[], declarations: [string, string][]) =>
					`${selectors.join(",\n")} {\n${declarations.map(([name, value]) => `  ${name}: ${value};\n`).join("")}}\n`;
				const code = (mode: "light" | "dark") => {
					const key = codeKey(theme.id, mode);
					return [
						["color", `var(--shiki-${key})`],
						["font-style", `var(--shiki-${key}-font-style, normal)`],
					] as [string, string][];
				};
				return [
					rule([...(isDefault ? [":root"] : []), own], Object.entries(theme.light).map(([token, value]) => [`--${token}`, value])),
					rule([...(isDefault ? [":root"] : []), own], [
						["--theme-font-ui", FONTS.ui[theme.fonts?.ui ?? "system"]],
						["--theme-font-code", FONTS.code[theme.fonts?.code ?? "system"]],
						["--theme-icon-lucide", theme.icons === "pixel" ? "none" : "inline"],
						["--theme-icon-pixel", theme.icons === "pixel" ? "inline" : "none"],
					]),
					rule([...(isDefault ? [".dark"] : []), `${own}.dark`], Object.entries(theme.dark).map(([token, value]) => [`--${token}`, value])),
					rule([...(isDefault ? [".shiki-token"] : []), `${own} .shiki-token`], code("light")),
					rule([...(isDefault ? [".dark .shiki-token"] : []), `${own}.dark .shiki-token`], code("dark")),
				].join("\n");
			})
			.join("\n");
	}
}
