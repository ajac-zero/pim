import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { describePage, type PimBrowser } from "../browser";
import { approvalNote, defineGatedAction, fileApproval, type GatedAction, ownToolPermission } from "./approvals";
import { type PimServices, text } from "./services";

/**
 * The person's browser as tools (see ../browser.ts). Opening and reading
 * pages, pointing at things, answering a page's dialogs, and saving
 * screenshots to the person's files run at once, as fetch_url does: a
 * dialog answers what an approved action, or the page itself, asked.
 * Clicking, typing and uploading files can do things on the web (send a
 * form, buy, post, share a file), so they ask first, as http_request does:
 * the request names the element as the page shows it, not as the model put
 * it, and the person can let them run without asking in Settings.
 */
export const BROWSER_EXTENSION = "pim.browser";
export const BROWSER_CLICK = "browser_click";
export const BROWSER_TYPE = "browser_type";
export const BROWSER_UPLOAD = "browser_upload";

const SHARED = `The browser is the Chrome on the person's computer. You have a window of your own in it, which keeps its page between your steps; other agents and chats have theirs, and what the person signed in to there is signed in in every window. If a page needs the person (signing in, a check that they're human, payment details), stop and ask them to take over: in the box beside the chat, under its summary, they choose Take over and tell you when they're done. Never ask them for passwords or codes in the chat.`;

const Ref = Type.Integer({ minimum: 1, description: "The element's number, from the page as browser_open or browser_read last showed it: 12 for [12 button “Search”]." });
const ClickArgs = Type.Object({ ref: Ref });
const TypeArgs = Type.Object({
	ref: Ref,
	text: Type.String({ maxLength: 2_000, description: "What to type. It replaces what the field held. In a list, the option to choose, by its text." }),
	submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing, which usually sends the form." })),
});
const UploadArgs = Type.Object({
	ref: Ref,
	paths: Type.Array(Type.String({ pattern: "^/workspace/", description: "A file in the person's files, as /workspace/report.pdf." }), {
		minItems: 1,
		maxItems: 10,
		description: "The files to upload: more than one only where the field takes several.",
	}),
});

export type BrowserServices = {
	readonly browser: PimBrowser;
	/** The window a conversation works in: its own, or its room's, which every agent in a group chat shares. */
	readonly windowOf: (conversation: string) => string;
	/** Saves a screenshot to the person's files, on their computer. */
	readonly saveScreenshot: (path: string | undefined, png: Uint8Array) => Promise<string>;
	/** Where a file in the person's files is on their computer, for the browser to upload; it must exist. */
	readonly localPath: (path: string) => Promise<string>;
};

function failure(error: unknown) {
	return text(error instanceof Error ? error.message : String(error), true);
}

/** Clicking, once the person approved what the request named. */
export function browserClickAction(browser: PimBrowser, windowOf: (conversation: string) => string): GatedAction {
	return defineGatedAction({
		name: BROWSER_CLICK,
		description: "Click a link or button in the agents' browser.",
		// Filed by the tool, which names the element as the page shows it.
		internal: true,
		parameters: ClickArgs,
		summarize: ({ ref }) => `Click [${ref}] in the browser`,
		async run({ ref }, { session }) {
			return describePage(await browser.click(windowOf(session), ref));
		},
	}) as GatedAction;
}

/** Typing, once the person approved what the request named. */
export function browserTypeAction(browser: PimBrowser, windowOf: (conversation: string) => string): GatedAction {
	return defineGatedAction({
		name: BROWSER_TYPE,
		description: "Type into a field in the agents' browser, and press Enter if asked.",
		internal: true,
		parameters: TypeArgs,
		summarize: ({ ref, text }) => `Type “${text}” into [${ref}] in the browser`,
		async run({ ref, text, submit }, { session }) {
			return describePage(await browser.type(windowOf(session), ref, text, submit === true));
		},
	}) as GatedAction;
}

/** Uploading files from the person's files, once the person approved what the request named. */
export function browserUploadAction(browser: PimBrowser, windowOf: (conversation: string) => string, localPath: (path: string) => Promise<string>): GatedAction {
	return defineGatedAction({
		name: BROWSER_UPLOAD,
		description: "Upload files from the person's files to a file field in the agents' browser.",
		internal: true,
		parameters: UploadArgs,
		summarize: ({ ref, paths }) => `Upload ${paths.join(", ")} with [${ref}] in the browser`,
		async run({ ref, paths }, { session }) {
			const files = await Promise.all(paths.map(localPath));
			return describePage(await browser.upload(windowOf(session), ref, files));
		},
	}) as GatedAction;
}

export function browserExtension(services: PimServices, { browser, windowOf, saveScreenshot, localPath }: BrowserServices) {
	const browserOpen = defineTool({
		name: "browser_open",
		description: `Open a web page in your window of the browser and read it: its text, with what can be clicked or typed into numbered like [12 link “Prices”]. Use it for pages fetch_url can't read (built by JavaScript) and for anything you need to click through. What the browser downloads goes to /workspace/downloads, and you're told where. ${SHARED}`,
		parameters: Type.Object({ url: Type.String({ pattern: "^(https?://|data:text/html)", description: "An http(s) address, or a data:text/html URL for HTML of your own." }) }),
		replay: "safe",
		async execute({ url }, api) {
			try {
				return text(describePage(await browser.visit(windowOf(String(api.conversationId)), url)));
			} catch (error) {
				return failure(error);
			}
		},
	});

	const browserRead = defineTool({
		name: "browser_read",
		description: "Read the page your window shows now, as browser_open does: after waiting for it to change, or after the person took over.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			try {
				const view = await browser.read(windowOf(String(api.conversationId)));
				return view ? text(describePage(view)) : text("Your window is closed. Open a page with browser_open.", true);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const browserHover = defineTool({
		name: "browser_hover",
		description: "Point at an element on your window's page, by its number, as a mouse does, for what shows only then (a menu, a tooltip); then read the page.",
		parameters: Type.Object({ ref: Ref }),
		replay: "safe",
		async execute({ ref }, api) {
			try {
				return text(describePage(await browser.hover(windowOf(String(api.conversationId)), ref)));
			} catch (error) {
				return failure(error);
			}
		},
	});

	const browserDialog = defineTool({
		name: "browser_dialog",
		description:
			"Answer the dialog your window's page shows (an alert, a confirm, a prompt, or one asking whether to leave), which holds the page until it's answered: `accept` it (OK, Leave), with `text` for a prompt, or dismiss it (Cancel, Stay). Then read the page.",
		parameters: Type.Object({
			accept: Type.Boolean({ description: "true for OK, false for Cancel." }),
			text: Type.Optional(Type.String({ maxLength: 2_000, description: "What to answer a prompt with." })),
		}),
		replay: "safe",
		async execute({ accept, text: answer }, api) {
			try {
				return text(describePage(await browser.answerDialog(windowOf(String(api.conversationId)), accept, answer)));
			} catch (error) {
				return failure(error);
			}
		},
	});

	const permissions = {
		click: ownToolPermission(services.store, BROWSER_CLICK).permission,
		type: ownToolPermission(services.store, BROWSER_TYPE).permission,
		upload: ownToolPermission(services.store, BROWSER_UPLOAD).permission,
	};

	const browserClick = defineTool({
		name: BROWSER_CLICK,
		description: `Click a link, button or other element on your window's page, by its number, and read the page it leads to.${permissions.click === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: ClickArgs,
		replay: "safe",
		async execute(args, api, context) {
			// The request keeps the summary it was filed with: when the call runs again after the decision, the page has changed (it may show a dialog the action opened).
			let summary = await api.memo<string>(BROWSER_CLICK, context);
			if (summary === undefined) {
				try {
					const element = await browser.describe(windowOf(String(api.conversationId)), args.ref);
					if (!element) return text(`There is no [${args.ref}] on the page now. Read the page again with browser_read and use a number it shows.`, true);
					summary = `On ${element.host}, click ${element.label}`;
				} catch (error) {
					return failure(error);
				}
				summary = await api.memo(BROWSER_CLICK, summary, context);
			}
			return fileApproval(services, api, context, { action: BROWSER_CLICK, tool: BROWSER_CLICK, args, summary });
		},
	});

	const browserType = defineTool({
		name: BROWSER_TYPE,
		description: `Type into a field on your window's page, by its number, replacing what it held, and press Enter after if \`submit\`, or choose an option in a list by its text; then read the page. Never type passwords or payment details: the person does that when they take over.${permissions.type === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: TypeArgs,
		replay: "safe",
		async execute(args, api, context) {
			// The request keeps the summary it was filed with: when the call runs again after the decision, the page has changed (it may show a dialog the action opened).
			let summary = await api.memo<string>(BROWSER_TYPE, context);
			if (summary === undefined) {
				try {
					const element = await browser.describe(windowOf(String(api.conversationId)), args.ref);
					if (!element) return text(`There is no [${args.ref}] on the page now. Read the page again with browser_read and use a number it shows.`, true);
					summary =
						element.role === "list"
							? `On ${element.host}, choose “${args.text}” in ${element.label}${args.submit ? " and press Enter" : ""}`
							: `On ${element.host}, type “${args.text}” into ${element.label}${args.submit ? " and press Enter" : ""}`;
				} catch (error) {
					return failure(error);
				}
				summary = await api.memo(BROWSER_TYPE, summary, context);
			}
			return fileApproval(services, api, context, { action: BROWSER_TYPE, tool: BROWSER_TYPE, args, summary });
		},
	});

	const browserUpload = defineTool({
		name: BROWSER_UPLOAD,
		description: `Upload files from the person's files to a file field on your window's page, by its number, or to the button that opens a file picker; then read the page.${permissions.upload === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: UploadArgs,
		replay: "safe",
		async execute(args, api, context) {
			// The request keeps the summary it was filed with: when the call runs again after the decision, the page has changed (it may show a dialog the action opened).
			let summary = await api.memo<string>(BROWSER_UPLOAD, context);
			if (summary === undefined) {
				try {
					const element = await browser.describe(windowOf(String(api.conversationId)), args.ref);
					if (!element) return text(`There is no [${args.ref}] on the page now. Read the page again with browser_read and use a number it shows.`, true);
					await Promise.all(args.paths.map(localPath));
					const names = args.paths.map((path) => path.slice(path.lastIndexOf("/") + 1));
					summary = `On ${element.host}, upload ${names.join(", ")} with ${element.label}`;
				} catch (error) {
					return failure(error);
				}
				summary = await api.memo(BROWSER_UPLOAD, summary, context);
			}
			return fileApproval(services, api, context, { action: BROWSER_UPLOAD, tool: BROWSER_UPLOAD, args, summary });
		},
	});

	const browserScreenshot = defineTool({
		name: "browser_screenshot",
		description: "Save a picture of your window's page to the person's files, to show them or keep. Returns where it was saved.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Where to save the PNG, under /workspace. Defaults to /workspace/screenshots/, named by the time." })),
		}),
		replay: "safe",
		async execute({ path }, api) {
			try {
				const png = await browser.screenshot(windowOf(String(api.conversationId)));
				if (!png) return text("Your window is closed. Open a page with browser_open.", true);
				return text(`Saved to ${await saveScreenshot(path, png)}.`);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const browserClose = defineTool({
		name: "browser_close",
		description: "Close your window when you're done with it; what's signed in there stays, and other windows go on.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args, api) {
			await browser.close(windowOf(String(api.conversationId)));
			return text("Your window is closed.");
		},
	});

	const tools: ToolRegistration[] = [browserOpen, browserRead, browserHover, browserDialog, browserScreenshot, browserClose];
	if (permissions.click !== "off") tools.push(browserClick);
	if (permissions.type !== "off") tools.push(browserType);
	if (permissions.upload !== "off") tools.push(browserUpload);
	return defineExtension({ name: BROWSER_EXTENSION, tools });
}
