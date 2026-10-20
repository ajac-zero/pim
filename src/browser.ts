import puppeteer, { type Browser, type CDPSession, type ElementHandle, type Page } from "@cloudflare/puppeteer";
import type { Computer } from "./computer";

/**
 * The person's web browser: the Chrome on their computer (see ./computer.ts),
 * which their agents share, as people share one browser across their tasks.
 * The space drives it over the DevTools protocol, through the computer's
 * connection; Chrome starts there when an agent first needs it, keeps its
 * profile, so what the person signs in to stays signed in, and quits after
 * a while unused. Browsing from the person's own machine, its address and
 * its sign-ins, sites treat it as theirs.
 *
 * Pages are read as text with numbered references to what can be clicked
 * or typed into. A reference is stored on its element in the page, and
 * numbers keep counting up across pages and sessions, so a reference that
 * waited for the person's approval reaches the element it named or none.
 *
 * The person can take it over: watch its page as a stream of pictures
 * (DevTools' screencast) and use it with their own mouse and keyboard, to
 * sign in or get past a check; the agents go on in the same pages after.
 */

/** How long a connection is kept between uses, before it is let go (the browser stays open). */
const CONNECTION_IDLE_MS = 30_000;
/** How much of a page's text an agent reads at once. */
const MAX_PAGE_CHARS = 12_000;

const NEXT_REF_KEY = "browser_next_ref";

type Meta = { get(key: string): string | null; set(key: string, value: string | null): void };

/** A page as an agent reads it. */
export type PageView = { url: string; title: string; text: string };

/** What a reference points to, for the person deciding whether to let an agent use it. */
export type ElementDescription = { host: string; label: string };

/** Where someone taking the browser over connects, behind the Worker's `/api/browser/live`. */
export const BROWSER_LIVE_PATH = "/browser/live";
/** The tag of the sockets of those taking the browser over. */
export const BROWSER_TAG = "browser";

/** What a socket taking the browser over hears. */
export type BrowserLiveMessage =
	| { type: "frame"; data: string; width: number; height: number }
	| { type: "page"; url: string; title: string }
	| { type: "error"; message: string };

/** Someone watching the browser to take it over: they get its page as pictures, and hear when it goes. */
export type Watcher = {
	/** A JPEG of the page, base64, `width` by `height` CSS pixels. */
	frame(frame: { data: string; width: number; height: number }): void;
	/** The page the browser shows changed. */
	page(page: { url: string; title: string }): void;
	/** The browser closed, or its computer went offline. */
	closed(): void;
};

/** What the person does in a browser they took over, in DevTools' terms. */
export type BrowserInput =
	| {
			type: "mouse";
			event: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
			x: number;
			y: number;
			button?: "none" | "left" | "middle" | "right";
			clickCount?: number;
			deltaX?: number;
			deltaY?: number;
			modifiers?: number;
	  }
	| { type: "key"; event: "keyDown" | "keyUp"; key: string; code: string; text?: string; keyCode?: number; modifiers?: number }
	| { type: "text"; text: string }
	| { type: "navigate"; url: string }
	| { type: "back" | "forward" | "reload" };

/**
 * Reads the page into lines of text, numbering what can be clicked or typed
 * into as `[12 button “Search”]`. Runs in the page, as a string so the
 * Worker's types don't need the DOM's. Takes the first number to give and
 * the most characters to read; returns the text and the next number.
 */
const READ_PAGE = `(([first, max]) => {
	let next = first;
	const lines = [];
	let line = "";
	let size = 0;
	const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true]';
	const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;
	const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|HEAD|META|LINK)$/;
	const clean = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
	const flush = () => {
		const text = clean(line);
		line = "";
		if (!text || size > max) return;
		lines.push(text);
		size += text.length + 1;
	};
	const visible = (el) => (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : true) && el.getAttribute("aria-hidden") !== "true";
	const nameOf = (el) => clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.innerText || el.value).slice(0, 80);
	const roleOf = (el) => {
		const role = el.getAttribute("role");
		if (role) return role;
		const tag = el.tagName;
		if (tag === "A") return "link";
		if (tag === "SELECT") return "select";
		if (tag === "TEXTAREA") return "textbox";
		if (tag === "SUMMARY") return "button";
		if (tag === "INPUT") {
			const type = (el.getAttribute("type") || "text").toLowerCase();
			if (["checkbox", "radio"].includes(type)) return type;
			if (["button", "submit", "reset", "image"].includes(type)) return "button";
			return type === "text" ? "textbox" : type + " field";
		}
		if (el.isContentEditable) return "textbox";
		return tag.toLowerCase();
	};
	const refOf = (el) => {
		let ref = el.getAttribute("data-pim-ref");
		if (!ref) {
			ref = String(next++);
			el.setAttribute("data-pim-ref", ref);
		}
		return ref;
	};
	// A control styled away behind its label (a custom checkbox) is clicked through the label, which gets its number.
	const token = (el, control = el) => {
		const role = roleOf(control);
		let token = "[" + refOf(el) + " " + role + " “" + nameOf(el) + "”";
		if (role === "checkbox" || role === "radio") token += control.checked ? " checked" : "";
		else if (control.tagName === "SELECT") token += " = “" + clean(control.selectedOptions[0] && control.selectedOptions[0].text) + "”";
		else if ((control.tagName === "INPUT" || control.tagName === "TEXTAREA") && control.value && control.type !== "password") token += " = “" + clean(control.value).slice(0, 80) + "”";
		return token + "]";
	};
	const walk = (node) => {
		for (const child of node.childNodes) {
			if (size > max) return;
			if (child.nodeType === 3) {
				line += child.textContent;
				continue;
			}
			if (child.nodeType !== 1 || SKIP.test(child.tagName) || !visible(child)) continue;
			if (child.tagName === "LABEL" && child.control && !visible(child.control)) {
				line += " " + token(child, child.control) + " ";
				continue;
			}
			if (child.matches(INTERACTIVE)) {
				line += " " + token(child) + " ";
				continue;
			}
			if (child.tagName === "IMG") {
				const alt = clean(child.getAttribute("alt"));
				if (alt) line += " (image: " + alt + ") ";
				continue;
			}
			const block = BLOCK.test(child.tagName);
			if (block) flush();
			if (/^H[1-6]$/.test(child.tagName)) line += "#".repeat(Number(child.tagName[1])) + " ";
			if (child.tagName === "LI") line += "- ";
			walk(child.shadowRoot || child);
			if (block) flush();
		}
	};
	walk(document.body || document.documentElement);
	flush();
	return { text: lines.join("\\n"), truncated: size > max, next };
})`;

/** Describes the element with a reference, or says there is none: run in the page. */
const DESCRIBE = `((ref) => {
	const el = document.querySelector('[data-pim-ref="' + ref + '"]');
	if (!el) return null;
	const clean = (value) => String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, 80);
	const tag = el.tagName;
	const type = (el.getAttribute("type") || "").toLowerCase();
	const role = el.getAttribute("role") || (tag === "A" ? "link" : tag === "SELECT" ? "list" : tag === "TEXTAREA" || (tag === "INPUT" && !["button", "submit", "reset", "image", "checkbox", "radio"].includes(type)) ? "text box" : tag === "INPUT" ? (["checkbox", "radio"].includes(type) ? type : "button") : tag === "BUTTON" || tag === "SUMMARY" ? "button" : tag.toLowerCase());
	const name = clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || el.value);
	return name ? "the " + role + " “" + name + "”" : "a " + role + " with no name";
})`;

export class PimBrowser {
	readonly #computer: Computer;
	readonly #meta: Meta;
	#browser: Browser | undefined;
	#idle: ReturnType<typeof setTimeout> | undefined;
	/** One use of the browser at a time: agents and the app take turns with its page. */
	#queue: Promise<unknown> = Promise.resolve();
	readonly #watchers = new Map<string, Watcher>();
	#screencast: { page: Page; session: CDPSession } | undefined;

	constructor(computer: Computer, meta: Meta) {
		this.#computer = computer;
		this.#meta = meta;
	}

	/** Whether the person has a browser: their computer's, while one is paired. */
	get available(): boolean {
		return this.#computer.paired();
	}

	/** Goes to `url` and reads the page. */
	async visit(url: string): Promise<PageView> {
		return this.#use(true, async (page) => {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
			await settle(page);
			return this.#read(page);
		});
	}

	/** The address and title of the page the browser shows, or null when it's closed or its computer is offline. */
	async current(): Promise<{ url: string; title: string } | null> {
		return this.#use(false, async (page) => ({ url: page.url(), title: await page.title() }));
	}

	/** Reads the page the browser shows now, or null when it's closed. */
	async read(): Promise<PageView | null> {
		return this.#use(false, (page) => this.#read(page));
	}

	/** What a reference on the current page points to, or null when it points to nothing now. */
	async describe(ref: number): Promise<ElementDescription | null> {
		const described = await this.#use(false, async (page) => {
			const label = await page.evaluate(`${DESCRIBE}(${JSON.stringify(String(ref))})`);
			return typeof label === "string" ? { host: hostOf(page.url()), label } : null;
		});
		return described ?? null;
	}

	/** Clicks the element with a reference and reads the page it leads to. */
	async click(ref: number): Promise<PageView> {
		return this.#act(ref, async (_page, element) => {
			await element.click();
		});
	}

	/** Types into the element with a reference, replacing what it held, and presses Enter after if asked. */
	async type(ref: number, text: string, submit: boolean): Promise<PageView> {
		return this.#act(ref, async (page, element) => {
			await element.click({ count: 3 });
			await element.evaluate((el: unknown) => {
				const field = el as { value?: unknown };
				if (typeof field.value === "string") field.value = "";
			});
			await element.type(text);
			if (submit) await page.keyboard.press("Enter");
		});
	}

	/** The page as an image, or null when the browser is closed. */
	async screenshot(): Promise<Uint8Array | null> {
		return this.#use(false, async (page) => (await page.screenshot({ type: "png" })) as Uint8Array);
	}

	/**
	 * Starts sending the page to `watcher` as pictures, for the person to
	 * take the browser over, under `id` (one per watching socket). False when
	 * the browser is closed: there is nothing to take over.
	 */
	async watch(id: string, watcher: Watcher): Promise<boolean> {
		this.#watchers.set(id, watcher);
		if (this.#screencast) {
			const { page } = this.#screencast;
			watcher.page({ url: page.url(), title: await page.title() });
			return true;
		}
		const started = await this.#use(false, async (page) => {
			const session = await page.createCDPSession();
			this.#screencast = { page, session };
			session.on("Page.screencastFrame", (event) => {
				const { data, metadata, sessionId } = event as { data: string; metadata: { deviceWidth: number; deviceHeight: number }; sessionId: number };
				for (const each of this.#watchers.values()) each.frame({ data, width: metadata.deviceWidth, height: metadata.deviceHeight });
				session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
			});
			const tell = async () => {
				const shown = { url: page.url(), title: await page.title().catch(() => "") };
				for (const each of this.#watchers.values()) each.page(shown);
			};
			page.on("framenavigated", (frame) => {
				if (frame === page.mainFrame()) void tell();
			});
			page.on("load", () => void tell());
			await session.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1920, maxHeight: 1920 });
			await tell();
			return true;
		});
		if (!started) this.#watchers.delete(id);
		return started === true;
	}

	/** `id` stopped watching; with nobody watching, the pictures stop. */
	async unwatch(id: string): Promise<void> {
		if (!this.#watchers.delete(id) || this.#watchers.size > 0) return;
		const screencast = this.#screencast;
		this.#screencast = undefined;
		if (!screencast) return;
		await screencast.session.send("Page.stopScreencast").catch(() => {});
		await screencast.session.detach().catch(() => {});
		screencast.page.removeAllListeners("framenavigated");
		screencast.page.removeAllListeners("load");
		this.#letGoLater();
	}

	/** Whether someone is taking the browser over now. */
	watched(): boolean {
		return this.#screencast !== undefined;
	}

	/** Whether `id` is watching, as far as this instance knows: a space that woke again has forgotten. */
	watching(id: string): boolean {
		return this.#watchers.has(id) && this.#screencast !== undefined;
	}

	/** What the person does in the browser they took over. */
	async input(event: BrowserInput): Promise<void> {
		const screencast = this.#screencast;
		if (!screencast) return;
		const { page, session } = screencast;
		switch (event.type) {
			case "mouse":
				await session.send("Input.dispatchMouseEvent", {
					type: event.event,
					x: event.x,
					y: event.y,
					button: event.button ?? "none",
					clickCount: event.clickCount ?? 0,
					modifiers: event.modifiers ?? 0,
					...(event.event === "mouseWheel" ? { deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 0 } : {}),
				});
				return;
			case "key":
				await session.send("Input.dispatchKeyEvent", {
					type: event.event === "keyDown" ? (event.text ? "keyDown" : "rawKeyDown") : "keyUp",
					key: event.key,
					code: event.code,
					modifiers: event.modifiers ?? 0,
					...(event.keyCode ? { windowsVirtualKeyCode: event.keyCode } : {}),
					...(event.event === "keyDown" && event.text ? { text: event.text, unmodifiedText: event.text } : {}),
				});
				return;
			case "text":
				await session.send("Input.insertText", { text: event.text });
				return;
			case "navigate":
				await page.goto(/^[a-z][a-z0-9+.-]*:/i.test(event.url) ? event.url : `https://${event.url}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
				return;
			case "back":
				await page.goBack({ timeout: 10_000 });
				return;
			case "forward":
				await page.goForward({ timeout: 10_000 });
				return;
			case "reload":
				await page.reload({ timeout: 30_000 });
				return;
		}
	}

	/** Quits the browser, with its pages; what's signed in there stays in its profile. */
	async close(): Promise<void> {
		await this.#enqueue(async () => {
			const browser = this.#browser;
			this.#browser = undefined;
			await browser?.disconnect().catch(() => {});
			this.#ended();
			if (this.#computer.status().state === "online") await this.#computer.stopBrowser();
		});
	}

	async #act(ref: number, act: (page: Page, element: ElementHandle) => Promise<void>): Promise<PageView> {
		const view = await this.#use(false, async (page) => {
			const element = await page.$(`[data-pim-ref="${ref}"]`);
			if (!element) throw new Error(`There is no [${ref}] on the page now. Read the page again with browser_read and use a number it shows.`);
			await act(page, element);
			await settle(page);
			return this.#read(page);
		});
		if (!view) throw new Error("The browser has closed since. Open the page again with browser_open.");
		return view;
	}

	async #read(page: Page): Promise<PageView> {
		const first = Number(this.#meta.get(NEXT_REF_KEY) ?? 1);
		const read = (await page.evaluate(`${READ_PAGE}(${JSON.stringify([first, MAX_PAGE_CHARS])})`)) as { text: string; truncated: boolean; next: number };
		this.#meta.set(NEXT_REF_KEY, String(read.next));
		const text = read.truncated ? `${read.text}\n[The page goes on; this is its first ${MAX_PAGE_CHARS} characters.]` : read.text;
		return { url: page.url(), title: await page.title(), text };
	}

	/**
	 * Runs `use` with the browser's page, one use at a time. With `start`, an
	 * agent's visit starts the browser when it isn't running; otherwise a
	 * closed browser, or one on a computer that's offline, answers null.
	 */
	#use<T>(start: true, use: (page: Page) => Promise<T>): Promise<T>;
	#use<T>(start: false, use: (page: Page) => Promise<T>): Promise<T | null>;
	#use<T>(start: boolean, use: (page: Page) => Promise<T>): Promise<T | null> {
		return this.#enqueue(async () => {
			const browser = await this.#browserFor(start);
			if (!browser) return null;
			const pages = await browser.pages();
			const page = pages.find((candidate) => !candidate.isClosed()) ?? (await browser.newPage());
			await this.#asItself(browser, page);
			try {
				return await use(page);
			} finally {
				this.#letGoLater();
			}
		});
	}

	#enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(work, work);
		this.#queue = run.catch(() => {});
		return run;
	}

	/** The connected browser, or the computer's, started first when `start` allows. */
	async #browserFor(start: boolean): Promise<Browser | undefined> {
		if (!this.available) throw new Error("This space has no browser: the person can connect a computer in Settings → Computer.");
		if (this.#browser?.connected) return this.#browser;
		this.#browser = undefined;
		if (!start) {
			const { running } = await this.#computer.browserStatus();
			if (!running) return undefined;
		}
		const transport = await this.#computer.connectBrowser();
		// The window's own size, so what the person sees when they take over is what the agents read.
		const browser = await puppeteer.connect({ transport, defaultViewport: null });
		browser.on("disconnected", () => {
			if (this.#browser !== browser) return;
			this.#browser = undefined;
			this.#ended();
		});
		this.#browser = browser;
		return browser;
	}

	/**
	 * Headless Chrome names itself `HeadlessChrome`, which sites turn away;
	 * each page says it's the Chrome it is, for as long as the space is
	 * connected to it.
	 */
	readonly #introduced = new WeakSet<Page>();
	async #asItself(browser: Browser, page: Page): Promise<void> {
		if (this.#introduced.has(page)) return;
		this.#introduced.add(page);
		const agent = await browser.userAgent();
		if (agent.includes("HeadlessChrome")) await page.setUserAgent(agent.replace("HeadlessChrome", "Chrome"));
	}

	/** The connection ended: anyone watching hears the browser is gone. */
	#ended(): void {
		this.#screencast = undefined;
		const watchers = [...this.#watchers.values()];
		this.#watchers.clear();
		for (const watcher of watchers) watcher.closed();
	}

	/** Lets the connection go after a while unused, unless someone is watching; the browser itself stays open. */
	#letGoLater(): void {
		clearTimeout(this.#idle);
		this.#idle = setTimeout(() => {
			if (this.#screencast) return;
			void this.#enqueue(async () => {
				if (this.#screencast) return;
				const browser = this.#browser;
				this.#browser = undefined;
				await browser?.disconnect().catch(() => {});
			});
		}, CONNECTION_IDLE_MS);
	}
}

/** Waits briefly for what an action set off (a navigation, a request) to finish. */
async function settle(page: Page): Promise<void> {
	await page.waitForNetworkIdle({ idleTime: 300, timeout: 5_000 }).catch(() => {});
}

/** Where a page is from, as the person reads it in an approval. */
function hostOf(url: string): string {
	if (url.startsWith("data:")) return "a page the agent wrote";
	try {
		return new URL(url).host || url.slice(0, 40);
	} catch {
		return url.slice(0, 40);
	}
}

/** The page as the model reads it. */
export function describePage(view: PageView): string {
	const url = view.url.startsWith("data:") ? "(HTML you wrote)" : view.url;
	return `Page: ${view.title || "(no title)"}\nURL: ${url}\n\n${view.text || "(The page shows no text.)"}`;
}
