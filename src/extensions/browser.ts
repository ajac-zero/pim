import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { describePage, type PimBrowser } from "../browser";
import { approvalNote, defineGatedAction, fileApproval, type GatedAction, ownToolPermission } from "./approvals";
import { type PimServices, text } from "./services";

/**
 * The person's browser as tools (see ../browser.ts). Opening and reading
 * pages, and saving screenshots to the person's files, run at once, as
 * fetch_url does. Clicking and typing can do things on the web (send a
 * form, buy, post), so they ask first, as http_request does: the request
 * names the element as the page shows it, not as the model put it, and the
 * person can let them run without asking in Settings.
 */
export const BROWSER_EXTENSION = "pim.browser";
export const BROWSER_CLICK = "browser_click";
export const BROWSER_TYPE = "browser_type";

const SHARED = `The browser is one Chrome the person's agents share; it starts signed in nowhere, keeps its pages between your steps, and closes itself after ten minutes unused. If a page needs the person (signing in, a check that they're human, payment details), stop and ask them to take over: under Browser in the app's sidebar, they choose Take over and tell you when they're done. Never ask them for passwords or codes in the chat.`;

const Ref = Type.Integer({ minimum: 1, description: "The element's number, from the page as browser_open or browser_read last showed it: 12 for [12 button “Search”]." });
const ClickArgs = Type.Object({ ref: Ref });
const TypeArgs = Type.Object({
	ref: Ref,
	text: Type.String({ maxLength: 2_000, description: "What to type. It replaces what the field held." }),
	submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing, which usually sends the form." })),
});

export type BrowserServices = { readonly browser: PimBrowser; readonly saveScreenshot: (path: string | undefined, png: Uint8Array) => Promise<string> };

function failure(error: unknown) {
	return text(error instanceof Error ? error.message : String(error), true);
}

/** Clicking, once the person approved what the request named. */
export function browserClickAction(browser: PimBrowser): GatedAction {
	return defineGatedAction({
		name: BROWSER_CLICK,
		description: "Click a link or button in the agents' browser.",
		// Filed by the tool, which names the element as the page shows it.
		internal: true,
		parameters: ClickArgs,
		summarize: ({ ref }) => `Click [${ref}] in the browser`,
		async run({ ref }) {
			return describePage(await browser.click(ref));
		},
	}) as GatedAction;
}

/** Typing, once the person approved what the request named. */
export function browserTypeAction(browser: PimBrowser): GatedAction {
	return defineGatedAction({
		name: BROWSER_TYPE,
		description: "Type into a field in the agents' browser, and press Enter if asked.",
		internal: true,
		parameters: TypeArgs,
		summarize: ({ ref, text }) => `Type “${text}” into [${ref}] in the browser`,
		async run({ ref, text, submit }) {
			return describePage(await browser.type(ref, text, submit === true));
		},
	}) as GatedAction;
}

export function browserExtension(services: PimServices, { browser, saveScreenshot }: BrowserServices) {
	const browserOpen = defineTool({
		name: "browser_open",
		description: `Open a web page in the browser and read it: its text, with what can be clicked or typed into numbered like [12 link “Prices”]. Use it for pages fetch_url can't read (built by JavaScript) and for anything you need to click through. ${SHARED}`,
		parameters: Type.Object({ url: Type.String({ pattern: "^(https?://|data:text/html)", description: "An http(s) address, or a data:text/html URL for HTML of your own." }) }),
		replay: "safe",
		async execute({ url }) {
			try {
				return text(describePage(await browser.visit(url)));
			} catch (error) {
				return failure(error);
			}
		},
	});

	const browserRead = defineTool({
		name: "browser_read",
		description: "Read the page the browser shows now, as browser_open does: after waiting for it to change, or after the person took over.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			try {
				const view = await browser.read();
				return view ? text(describePage(view)) : text("The browser is closed. Open a page with browser_open.", true);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const permissions = {
		click: ownToolPermission(services.store, BROWSER_CLICK).permission,
		type: ownToolPermission(services.store, BROWSER_TYPE).permission,
	};

	const browserClick = defineTool({
		name: BROWSER_CLICK,
		description: `Click a link, button or other element on the browser's page, by its number, and read the page it leads to.${permissions.click === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: ClickArgs,
		replay: "safe",
		async execute(args, api, context) {
			let summary: string;
			try {
				const element = await browser.describe(args.ref);
				if (!element) return text(`There is no [${args.ref}] on the page now. Read the page again with browser_read and use a number it shows.`, true);
				summary = `On ${element.host}, click ${element.label}`;
			} catch (error) {
				return failure(error);
			}
			summary = await api.memo(BROWSER_CLICK, summary, context);
			return fileApproval(services, api, context, { action: BROWSER_CLICK, tool: BROWSER_CLICK, args, summary });
		},
	});

	const browserType = defineTool({
		name: BROWSER_TYPE,
		description: `Type into a field on the browser's page, by its number, replacing what it held, and press Enter after if \`submit\`; then read the page. Never type passwords or payment details: the person does that when they take over.${permissions.type === "ask" ? ` ${approvalNote(services)}` : ""}`,
		parameters: TypeArgs,
		replay: "safe",
		async execute(args, api, context) {
			let summary: string;
			try {
				const element = await browser.describe(args.ref);
				if (!element) return text(`There is no [${args.ref}] on the page now. Read the page again with browser_read and use a number it shows.`, true);
				summary = `On ${element.host}, type “${args.text}” into ${element.label}${args.submit ? " and press Enter" : ""}`;
			} catch (error) {
				return failure(error);
			}
			summary = await api.memo(BROWSER_TYPE, summary, context);
			return fileApproval(services, api, context, { action: BROWSER_TYPE, tool: BROWSER_TYPE, args, summary });
		},
	});

	const browserScreenshot = defineTool({
		name: "browser_screenshot",
		description: "Save a picture of the browser's page to the person's files, to show them or keep. Returns where it was saved.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Where to save the PNG, under /workspace. Defaults to /workspace/screenshots/, named by the time." })),
		}),
		replay: "safe",
		async execute({ path }) {
			try {
				const png = await browser.screenshot();
				if (!png) return text("The browser is closed. Open a page with browser_open.", true);
				return text(`Saved to ${await saveScreenshot(path, png)}.`);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const browserClose = defineTool({
		name: "browser_close",
		description: "Close the browser when you're done with it, with its pages and anything signed in there. It also closes itself after ten minutes unused.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			await browser.close();
			return text("The browser is closed.");
		},
	});

	const tools: ToolRegistration[] = [browserOpen, browserRead, browserScreenshot, browserClose];
	if (permissions.click !== "off") tools.push(browserClick);
	if (permissions.type !== "off") tools.push(browserType);
	return defineExtension({ name: BROWSER_EXTENSION, tools });
}
