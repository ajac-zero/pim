import puppeteer, { type Browser, type ElementHandle, type Page } from "@cloudflare/puppeteer";

/**
 * The person's web browser: one Chrome on Browser Run that their agents
 * share, as people share one browser across their tasks. It is opened when
 * an agent first needs it and closes itself after `IDLE_MS` without use, so
 * it costs browser time only while someone is browsing. Its session ID is
 * kept in the space's meta, so a space that wakes again goes on with the same
 * pages. The browser starts signed in nowhere; the person can take it over
 * (Live View, where Browser Run offers it) to sign in or solve a check, and
 * the agents carry on in the same pages afterwards.
 *
 * Pages are read as text with numbered references to what can be clicked
 * or typed into. A reference is stored on its element in the page, and
 * numbers keep counting up across pages and sessions, so a reference that
 * waited for the person's approval reaches the element it named or none.
 */

/** How long the browser stays open without being used. Browser Run allows at most ten minutes. */
const IDLE_MS = 600_000;
/** How long a connection is kept between uses, before it is let go (the browser stays open). */
const CONNECTION_IDLE_MS = 30_000;
/** How much of a page's text an agent reads at once. */
const MAX_PAGE_CHARS = 12_000;

const SESSION_KEY = "browser_session";
const NEXT_REF_KEY = "browser_next_ref";

type Meta = { get(key: string): string | null; set(key: string, value: string | null): void };

/** A page as an agent reads it. */
export type PageView = { url: string; title: string; text: string };

/** What a reference points to, for the person deciding whether to let an agent use it. */
export type ElementDescription = { host: string; label: string };

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
	readonly #binding: BrowserRun | undefined;
	readonly #meta: Meta;
	#browser: Browser | undefined;
	#idle: ReturnType<typeof setTimeout> | undefined;
	/** One use of the browser at a time: agents and the app take turns with its page. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(binding: BrowserRun | undefined, meta: Meta) {
		this.#binding = binding;
		this.#meta = meta;
	}

	/** Whether this deployment has a browser (a `browser` binding). */
	get available(): boolean {
		return this.#binding !== undefined;
	}

	/** Whether a browser is open, as far as this space knows; it may have closed itself since. */
	get open(): boolean {
		return this.#meta.get(SESSION_KEY) !== null;
	}

	/** Goes to `url` and reads the page. */
	async visit(url: string): Promise<PageView> {
		return this.#use(true, async (page) => {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
			await settle(page);
			return this.#read(page);
		});
	}

	/** The address and title of the page the browser shows, or null when it's closed. */
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
		return this.#act(ref, async (page, element) => {
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
	 * A link that lets the person watch and use the browser themselves, valid
	 * to open for five minutes; null when the browser is closed. Throws where
	 * Browser Run doesn't offer it, as on a local Chrome. The link carries its
	 * own access token, so only the person gets it, never the model.
	 */
	async liveView(): Promise<string | null> {
		return this.#use(false, async (page) => {
			const session = await page.createCDPSession();
			try {
				const { devtoolsFrontendUrl } = (await session.send("Cloudflare.getLiveView" as never, { mode: "tab", expiresInMs: 300_000 } as never)) as {
					devtoolsFrontendUrl: string;
				};
				return devtoolsFrontendUrl;
			} catch {
				throw new Error("Taking over the browser needs Browser Run's Live View, which this browser doesn't offer.");
			} finally {
				await session.detach().catch(() => {});
			}
		});
	}

	/** Closes the browser, with its pages and whatever was signed in there. */
	async close(): Promise<void> {
		await this.#enqueue(async () => {
			const sessionId = this.#meta.get(SESSION_KEY);
			this.#meta.set(SESSION_KEY, null);
			const browser = this.#browser ?? (sessionId ? await this.#connect(sessionId) : undefined);
			this.#browser = undefined;
			await browser?.close().catch(() => {});
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
	 * agent's visit opens the browser when none is open; otherwise a closed
	 * browser answers null.
	 */
	#use<T>(start: true, use: (page: Page) => Promise<T>): Promise<T>;
	#use<T>(start: false, use: (page: Page) => Promise<T>): Promise<T | null>;
	#use<T>(start: boolean, use: (page: Page) => Promise<T>): Promise<T | null> {
		return this.#enqueue(async () => {
			const browser = await this.#browserFor(start);
			if (!browser) return null;
			const pages = await browser.pages();
			const page = pages.find((candidate) => !candidate.isClosed()) ?? (await browser.newPage());
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

	/** The connected browser: the one this space has open, or a new one when `start` allows. */
	async #browserFor(start: boolean): Promise<Browser | undefined> {
		if (!this.#binding) throw new Error("This space has no browser.");
		if (this.#browser?.connected) return this.#browser;
		this.#browser = undefined;
		const sessionId = this.#meta.get(SESSION_KEY);
		if (sessionId) {
			this.#browser = await this.#connect(sessionId);
			// It closed itself after going unused, or Browser Run ended it.
			if (!this.#browser) this.#meta.set(SESSION_KEY, null);
		}
		if (!this.#browser && start) {
			this.#browser = await puppeteer.launch(this.#binding as never, { keep_alive: IDLE_MS });
			this.#meta.set(SESSION_KEY, this.#browser.sessionId());
		}
		return this.#browser;
	}

	async #connect(sessionId: string): Promise<Browser | undefined> {
		try {
			return await puppeteer.connect(this.#binding as never, sessionId);
		} catch {
			return undefined;
		}
	}

	/** Lets the connection go after a while unused; the browser itself stays open until it idles out. */
	#letGoLater(): void {
		clearTimeout(this.#idle);
		this.#idle = setTimeout(() => {
			void this.#enqueue(async () => {
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
