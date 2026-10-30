import { posix } from "node:path";
import puppeteer, { type Browser, type CDPSession, type Dialog, type ElementHandle, type Page, type Target } from "@cloudflare/puppeteer";
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
 * Each chat (each conversation: a chat, or a task an agent handed out) has
 * a window of its own, as if each agent had a screen of its own, so agents
 * browsing at once don't take each other's pages, and work in their windows
 * at the same time; one window does one thing at a time. A tab would do
 * for keeping pages apart, but Chrome doesn't draw a tab behind another,
 * which breaks pages that wait to be seen. The windows share the profile,
 * so what the person signs in to is signed in in all of them. Where each
 * window is, is kept, so it opens again there after the browser quits.
 *
 * Pages are read as text with numbered references to what can be clicked
 * or typed into. A reference is stored on its element in the page, and
 * numbers keep counting up across pages and sessions, so a reference that
 * waited for the person's approval reaches the element it named or none.
 *
 * A dialog a page opens (an alert, a confirm, a prompt, or one asking
 * whether to leave) holds the page until it's answered, so the agent reads
 * it in place of the page and answers it; one left unanswered when the
 * connection is let go is dismissed, since it would hold the page from the
 * next connection too. What the browser downloads goes
 * to the person's files, in /workspace/downloads, and the agent hears where.
 *
 * The person can take a window over: watch its page as a stream of
 * pictures (DevTools' screencast) and use it with their own mouse and
 * keyboard, to sign in or get past a check; its agent goes on in the same
 * page after.
 */

/** How long a connection is kept between uses, before it is let go (the browser stays open). */
const CONNECTION_IDLE_MS = 30_000;
/** How much of a page's text an agent reads at once. */
const MAX_PAGE_CHARS = 12_000;

const NEXT_REF_KEY = "browser_next_ref";
/** Each chat's window: where it is and when it was used, so it opens again where it was. */
const WINDOWS_KEY = "browser_windows";
/** Where downloads go, in the person's files. */
export const DOWNLOADS = "/workspace/downloads";
/** How long an action waits for a download it started to finish, before the agent hears it's still going. */
const DOWNLOAD_WAIT_MS = 30_000;
/** The most windows open at once; opening another closes the one used longest ago, which opens again where it was when it's next needed. */
const MAX_WINDOWS = 6;
/** How many chats' windows are remembered. */
const MAX_RECORDS = 30;

/** A chat's window: its target in the running browser, if it's open, and the page it showed when last used. */
type WindowRecord = { target: string | null; url: string; title: string; usedAt: number };

/** How a use finds the chat's window when it isn't open. */
type OpenMode = "open" | "reopen" | "existing";

/** A window being taken over: its page, the DevTools session sending its pictures, and who is watching. */
type Screencast = { page: Page; session: CDPSession; watchers: Map<string, Watcher> };

type Meta = { get(key: string): string | null; set(key: string, value: string | null): void };

/** A page as an agent reads it, with what it should know first: the downloads its action started. */
export type PageView = { url: string; title: string; text: string; note?: string };

/** What a reference points to, for the person deciding whether to let an agent use it: `label` names it, as "the button “Buy”". */
export type ElementDescription = { host: string; role: string; label: string };

/** A download the browser started: what it's called, the frame that started it, and, once it's done, where it went. */
type Download = { name: string; frame: string; startedAt: number; state: "inProgress" | "completed" | "canceled"; path: string | null };

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
	const role = el.getAttribute("role") || (tag === "A" ? "link" : tag === "SELECT" ? "list" : tag === "INPUT" && type === "file" ? "file field" : tag === "TEXTAREA" || (tag === "INPUT" && !["button", "submit", "reset", "image", "checkbox", "radio"].includes(type)) ? "text box" : tag === "INPUT" ? (["checkbox", "radio"].includes(type) ? type : "button") : tag === "BUTTON" || tag === "SUMMARY" ? "button" : tag.toLowerCase());
	const name = clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || el.value);
	return [role, name ? "the " + role + " “" + name + "”" : "a " + role + " with no name"];
})`;

export class PimBrowser {
	readonly #computer: Computer;
	readonly #meta: Meta;
	#browser: Browser | undefined;
	#connecting: Promise<Browser | undefined> | undefined;
	#idle: ReturnType<typeof setTimeout> | undefined;
	/** Uses of the browser under way, in any window. */
	#busy = 0;
	/** Each chat's window, while the space is connected to the browser. */
	readonly #pages = new Map<string, Page>();
	/** Each window's turn: one use at a time in a window, while the others go on. */
	readonly #turns = new Map<string, Promise<unknown>>();
	/** The windows being taken over, by chat, each with who is watching it. */
	readonly #screencasts = new Map<string, Screencast>();
	/** The chat of the window each watcher watches. */
	readonly #watching = new Map<string, string>();
	/** The dialog each page shows, which holds it until it's answered. */
	readonly #dialogs = new WeakMap<Page, Dialog>();
	/** The browser's downloads while the space is connected to it, by DevTools' id. */
	readonly #downloads = new Map<string, Download>();

	constructor(computer: Computer, meta: Meta) {
		this.#computer = computer;
		this.#meta = meta;
	}

	/** Whether the person has a browser: their computer's, while one is paired. */
	get available(): boolean {
		return this.#computer.paired();
	}

	/** Goes to `url` in the chat's window, opening one if it has none, and reads the page. */
	async visit(chat: string, url: string): Promise<PageView> {
		return this.#use(chat, "open", async (page) => {
			const since = Date.now();
			try {
				await untilDialog(page, page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }));
			} catch (error) {
				// An address that downloads a file isn't a page Chrome goes to.
				if (this.#startedDownloads(page, since).length === 0) throw error;
			}
			return this.#after(chat, page, since);
		});
	}

	/** The address and title of the page the chat's window shows, or null when it has none open or the computer is offline. */
	async current(chat: string): Promise<{ url: string; title: string } | null> {
		const shown = await this.#use(chat, "existing", async (page) => this.#remember(chat, page, await this.#titleOf(page)));
		return shown ? { url: shown.url, title: shown.title } : null;
	}

	/** Of `chats`, the one whose window was used last: a chat and the tasks it handed out, whose windows it shows. */
	lastUsed(chats: readonly string[]): string {
		const records = this.#records();
		return chats.reduce((best, chat) => ((records[chat]?.usedAt ?? -1) > (records[best]?.usedAt ?? -1) ? chat : best), chats[0]!);
	}

	/** Reads the page the chat's window shows now, or null when it has none open. */
	async read(chat: string): Promise<PageView | null> {
		return this.#use(chat, "existing", (page) => this.#read(chat, page));
	}

	/** What a reference on the chat's page points to, or null when it points to nothing now. */
	async describe(chat: string, ref: number): Promise<ElementDescription | null> {
		const described = await this.#use(chat, "existing", async (page) => {
			this.#noDialog(page);
			const found = (await page.evaluate(`${DESCRIBE}(${JSON.stringify(String(ref))})`)) as [string, string] | null;
			return found ? { host: hostOf(page.url()), role: found[0], label: found[1] } : null;
		});
		return described ?? null;
	}

	/** Clicks the element with a reference and reads the page it leads to. */
	async click(chat: string, ref: number): Promise<PageView> {
		return this.#act(chat, ref, async (_page, element) => {
			await element.click();
		});
	}

	/** Points at the element with a reference, as a mouse does, for what shows on hover (a menu), and reads the page. */
	async hover(chat: string, ref: number): Promise<PageView> {
		return this.#act(chat, ref, async (_page, element) => {
			await element.hover();
		});
	}

	/**
	 * Types into the element with a reference, replacing what it held, and
	 * presses Enter after if asked. In a list (a `<select>`), it chooses the
	 * option the text names.
	 */
	async type(chat: string, ref: number, text: string, submit: boolean): Promise<PageView> {
		return this.#act(chat, ref, async (page, element) => {
			const options = await element.evaluate((el: unknown) => {
				const list = el as { tagName: string; options: ArrayLike<{ value: string; text: string }> };
				return list.tagName === "SELECT" ? Array.from(list.options, (option) => ({ value: option.value, label: option.text.trim() })) : null;
			});
			if (options) {
				const wanted = text.trim().toLowerCase();
				const option = options.find(({ label }) => label.toLowerCase() === wanted) ?? options.find(({ value }) => value.toLowerCase() === wanted);
				if (!option) throw new Error(`The list has no option “${text}”. Its options: ${options.map(({ label }) => `“${label}”`).join(", ")}.`);
				await element.select(option.value);
				if (submit) await page.keyboard.press("Enter");
				return;
			}
			await element.click({ count: 3 });
			await element.evaluate((el: unknown) => {
				const field = el as { value?: unknown };
				if (typeof field.value === "string") field.value = "";
			});
			await element.type(text);
			if (submit) await page.keyboard.press("Enter");
		});
	}

	/**
	 * Gives files to the file field with a reference, or to the file picker
	 * the element opens when clicked (a button in place of a hidden field).
	 * `files` are paths on the computer.
	 */
	async upload(chat: string, ref: number, files: readonly string[]): Promise<PageView> {
		return this.#act(chat, ref, async (page, element) => {
			const field = await element.evaluate((el: unknown) => {
				const input = el as { tagName: string; type?: string };
				return input.tagName === "INPUT" && input.type === "file";
			});
			if (field) {
				await (element as ElementHandle<never>).uploadFile(...files);
				return;
			}
			const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10_000 }), element.click()]).catch(() => {
				throw new Error(`[${ref}] doesn't open a file picker. Upload to a file field, or to the button that opens one.`);
			});
			await chooser.accept([...files]);
		});
	}

	/** Answers the dialog the chat's page shows: accepts it (with `text`, for a prompt) or dismisses it; then reads the page. */
	async answerDialog(chat: string, accept: boolean, text?: string): Promise<PageView> {
		const view = await this.#use(chat, "existing", async (page) => {
			const dialog = this.#dialogs.get(page);
			if (!dialog) throw new Error("Your window's page shows no dialog now. Read it with browser_read.");
			const since = Date.now();
			this.#dialogs.delete(page);
			// The person may have answered it on the desktop already.
			await (accept ? dialog.accept(text) : dialog.dismiss()).catch(() => {});
			return this.#after(chat, page, since);
		});
		if (!view) throw new Error("Your window has closed since. Open the page again with browser_open.");
		return view;
	}

	/** The chat's page as an image, or null when it has none open. */
	async screenshot(chat: string): Promise<Uint8Array | null> {
		return this.#use(chat, "existing", async (page) => {
			this.#noDialog(page);
			return (await page.screenshot({ type: "png" })) as Uint8Array;
		});
	}

	/**
	 * Starts sending the chat's window to `watcher` as pictures, for the
	 * person to take it over, under `id` (one per watching socket). A window
	 * that isn't open opens where it was, starting the browser if it isn't
	 * running.
	 */
	async watch(chat: string, id: string, watcher: Watcher): Promise<void> {
		this.#watching.set(id, chat);
		const watched = this.#screencasts.get(chat);
		if (watched) {
			watched.watchers.set(id, watcher);
			watcher.page({ url: watched.page.url(), title: (await this.#titleOf(watched.page)) ?? "" });
			return;
		}
		await this.#use(chat, "reopen", async (page) => {
			const started = this.#screencasts.get(chat);
			if (started) {
				started.watchers.set(id, watcher);
				return;
			}
			const session = await page.createCDPSession();
			const screencast: Screencast = { page, session, watchers: new Map([[id, watcher]]) };
			this.#screencasts.set(chat, screencast);
			session.on("Page.screencastFrame", (event) => {
				const { data, metadata, sessionId } = event as { data: string; metadata: { deviceWidth: number; deviceHeight: number }; sessionId: number };
				for (const each of screencast.watchers.values()) each.frame({ data, width: metadata.deviceWidth, height: metadata.deviceHeight });
				session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
			});
			const tell = async () => {
				const shown = this.#remember(chat, page, await this.#titleOf(page).catch(() => ""));
				for (const each of screencast.watchers.values()) each.page(shown);
			};
			page.on("framenavigated", (frame) => {
				if (frame === page.mainFrame()) void tell();
			});
			page.on("load", () => void tell());
			page.once("close", () => this.#endScreencast(chat));
			// A page Chrome restored as it started isn't drawn, so it sends no pictures, until it's in front.
			await page.bringToFront();
			await session.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1920, maxHeight: 1920 });
			await tell();
		}).catch((error) => {
			this.#watching.delete(id);
			throw error;
		});
	}

	/** `id` stopped watching; with nobody watching a window, its pictures stop. */
	async unwatch(id: string): Promise<void> {
		const chat = this.#watching.get(id);
		this.#watching.delete(id);
		const screencast = chat === undefined ? undefined : this.#screencasts.get(chat);
		if (!screencast || !screencast.watchers.delete(id) || screencast.watchers.size > 0) return;
		this.#screencasts.delete(chat!);
		await screencast.session.send("Page.stopScreencast").catch(() => {});
		await screencast.session.detach().catch(() => {});
		screencast.page.removeAllListeners("framenavigated");
		screencast.page.removeAllListeners("load");
		screencast.page.removeAllListeners("close");
		this.#letGoLater();
	}

	/** Whether `id` is watching, as far as this instance knows: a space that woke again has forgotten. */
	watching(id: string): boolean {
		const chat = this.#watching.get(id);
		return chat !== undefined && this.#screencasts.get(chat)?.watchers.has(id) === true;
	}

	/** What the person does in the window `id` took over. */
	async input(id: string, event: BrowserInput): Promise<void> {
		const chat = this.#watching.get(id);
		const screencast = chat === undefined ? undefined : this.#screencasts.get(chat);
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

	/** Closes the chat's window, and forgets where it was; the browser and its other windows go on. */
	async close(chat: string): Promise<void> {
		await this.#use(chat, "existing", async (page) => {
			await page.close();
		});
		this.#pages.delete(chat);
		const records = this.#records();
		delete records[chat];
		this.#saveRecords(records);
	}

	/** Quits the browser, with every window; what's signed in there stays in its profile. */
	async quit(): Promise<void> {
		const browser = this.#browser;
		this.#browser = undefined;
		await browser?.disconnect().catch(() => {});
		this.#ended();
		this.#meta.set(WINDOWS_KEY, null);
		if (this.#computer.status().state === "online") await this.#computer.stopBrowser();
	}

	async #act(chat: string, ref: number, act: (page: Page, element: ElementHandle) => Promise<void>): Promise<PageView> {
		const view = await this.#use(chat, "existing", async (page) => {
			this.#noDialog(page);
			const element = await page.$(`[data-pim-ref="${ref}"]`);
			if (!element) throw new Error(`There is no [${ref}] on the page now. Read the page again with browser_read and use a number it shows.`);
			const since = Date.now();
			await untilDialog(page, act(page, element));
			return this.#after(chat, page, since);
		});
		if (!view) throw new Error("Your window has closed since. Open the page again with browser_open.");
		return view;
	}

	/** Reads the page after an action that began at `since`: once what it set off settled, with the downloads it started, or the dialog it opened. */
	async #after(chat: string, page: Page, since: number): Promise<PageView> {
		if (!this.#dialogs.has(page)) await settle(page);
		const downloads = this.#startedDownloads(page, since);
		const until = Date.now() + DOWNLOAD_WAIT_MS;
		while (downloads.some((download) => download.state === "inProgress") && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
		const view = await this.#read(chat, page);
		if (downloads.length === 0) return view;
		const note = downloads
			.map(({ name, state, path }) =>
				state === "completed"
					? `Downloaded “${name}” to ${path ?? `${DOWNLOADS}/${name}`}.`
					: state === "canceled"
						? `The download of “${name}” was canceled.`
						: `“${name}” is still downloading to ${DOWNLOADS}; look for it there later.`,
			)
			.join("\n");
		return { ...view, note };
	}

	/** The downloads the page's frames started since `since`. */
	#startedDownloads(page: Page, since: number): Download[] {
		const frames = new Set(page.frames().map(frameIdOf));
		return [...this.#downloads.values()].filter((download) => download.startedAt >= since && frames.has(download.frame));
	}

	/** The page's title, or none while a dialog holds it (reading it would wait for the dialog). */
	async #titleOf(page: Page): Promise<string | undefined> {
		return this.#dialogs.has(page) ? undefined : page.title();
	}

	/** Refuses to use a page a dialog holds: the agent answers the dialog first. */
	#noDialog(page: Page): void {
		if (this.#dialogs.has(page)) throw new Error("A dialog on the page holds it: read it with browser_read and answer it with browser_dialog first.");
	}

	async #read(chat: string, page: Page): Promise<PageView> {
		const dialog = this.#dialogs.get(page);
		if (dialog) return { ...this.#remember(chat, page), text: describeDialog(dialog) };
		const first = Number(this.#meta.get(NEXT_REF_KEY) ?? 1);
		const read = (await page.evaluate(`${READ_PAGE}(${JSON.stringify([first, MAX_PAGE_CHARS])})`)) as { text: string; truncated: boolean; next: number };
		this.#meta.set(NEXT_REF_KEY, String(read.next));
		const text = read.truncated ? `${read.text}\n[The page goes on; this is its first ${MAX_PAGE_CHARS} characters.]` : read.text;
		return { ...this.#remember(chat, page, await page.title()), text };
	}

	#records(): Record<string, WindowRecord> {
		const kept = this.#meta.get(WINDOWS_KEY);
		return kept ? (JSON.parse(kept) as Record<string, WindowRecord>) : {};
	}

	#saveRecords(records: Record<string, WindowRecord>): void {
		const kept = Object.entries(records)
			.sort(([, a], [, b]) => b.usedAt - a.usedAt)
			.slice(0, MAX_RECORDS);
		this.#meta.set(WINDOWS_KEY, kept.length > 0 ? JSON.stringify(Object.fromEntries(kept)) : null);
	}

	/** Writes down where the chat's window is and that it was just used; its title, when it's known. */
	#remember(chat: string, page: Page, title?: string): { url: string; title: string } {
		const records = this.#records();
		const before = records[chat];
		const url = page.url();
		const shown = { url, title: title ?? (before?.url === url ? before.title : "") };
		records[chat] = { target: targetIdOf(page.target()), ...shown, usedAt: Date.now() };
		this.#saveRecords(records);
		return shown;
	}

	/**
	 * Runs `use` with the chat's window, one use at a time in it. A window
	 * that isn't open opens with `open` (on a blank page, for an agent about
	 * to go somewhere) or `reopen` (where it was, for the person taking it
	 * over), starting the browser if it isn't running; with `existing`, a
	 * closed window, or a browser that isn't running or whose computer is
	 * offline, answers null.
	 */
	#use<T>(chat: string, mode: "open" | "reopen", use: (page: Page) => Promise<T>): Promise<T>;
	#use<T>(chat: string, mode: "existing", use: (page: Page) => Promise<T>): Promise<T | null>;
	#use<T>(chat: string, mode: OpenMode, use: (page: Page) => Promise<T>): Promise<T | null> {
		const work = async () => {
			this.#busy++;
			try {
				const page = await this.#window(chat, mode);
				if (!page) return null;
				const result = await use(page);
				if (!page.isClosed()) this.#remember(chat, page);
				return result;
			} finally {
				this.#busy--;
				this.#letGoLater();
			}
		};
		const run = (this.#turns.get(chat) ?? Promise.resolve()).then(work, work);
		const turn = run.catch(() => {});
		this.#turns.set(chat, turn);
		void turn.then(() => {
			if (this.#turns.get(chat) === turn) this.#turns.delete(chat);
		});
		return run;
	}

	/** The chat's window: the one it has open, or, as `mode` allows, one opened for it. */
	async #window(chat: string, mode: OpenMode): Promise<Page | undefined> {
		const browser = await this.#connect(mode !== "existing");
		if (!browser) return undefined;
		const known = this.#pages.get(chat);
		if (known && !known.isClosed()) return known;
		this.#pages.delete(chat);
		const record = this.#records()[chat];
		let page = record?.target ? await pageOf(browser, record.target) : undefined;
		if (!page) {
			if (mode === "existing") return undefined;
			page = await this.#openWindow(browser, mode === "reopen" && record ? record.url : "about:blank");
			this.#pages.set(chat, page);
			this.#remember(chat, page, mode === "reopen" ? record?.title : "");
			await this.#closeLeastUsed(chat);
		}
		await this.#prepare(browser, page);
		this.#pages.set(chat, page);
		return page;
	}

	/** Opens a window of its own: a tab sharing one would be hidden behind it, and not drawn. */
	async #openWindow(browser: Browser, url: string): Promise<Page> {
		const session = await browser.target().createCDPSession();
		let targetId: string;
		try {
			({ targetId } = (await session.send("Target.createTarget", { url, newWindow: true, width: 1280, height: 800 })) as { targetId: string });
		} finally {
			await session.detach().catch(() => {});
		}
		const target = await browser.waitForTarget((candidate) => targetIdOf(candidate) === targetId, { timeout: 10_000 });
		const page = await target.page();
		if (!page) throw new Error("The browser couldn't open a window.");
		return page;
	}

	/** With more than `MAX_WINDOWS` open, closes the one used longest ago, but not `keep`'s or one being taken over; it opens again where it was. */
	async #closeLeastUsed(keep: string): Promise<void> {
		const records = this.#records();
		const open = [...this.#pages.entries()].filter(([, page]) => !page.isClosed());
		if (open.length <= MAX_WINDOWS) return;
		const [chat, page] = open
			.filter(([chat]) => chat !== keep && !this.#screencasts.has(chat) && !this.#turns.has(chat))
			.sort(([a], [b]) => (records[a]?.usedAt ?? 0) - (records[b]?.usedAt ?? 0))[0] ?? [undefined, undefined];
		if (!chat || !page) return;
		this.#pages.delete(chat);
		await page.close().catch(() => {});
	}

	/** The browser, connected to, started first when `start` allows. */
	async #connect(start: boolean): Promise<Browser | undefined> {
		if (!this.available) throw new Error("This space has no browser: the person can connect a computer in Settings → Computer.");
		if (this.#browser?.connected) return this.#browser;
		const connecting = (this.#connecting ??= (async () => {
			this.#browser = undefined;
			this.#pages.clear();
			const { running } = await this.#computer.browserStatus();
			if (!running && !start) return undefined;
			const transport = await this.#computer.connectBrowser();
			// The window's own size, so what the person sees when they take over is what the agents read.
			const browser = await puppeteer.connect({ transport, defaultViewport: null });
			browser.on("disconnected", () => {
				if (this.#browser !== browser) return;
				this.#browser = undefined;
				this.#ended();
			});
			await this.#downloadToFiles(browser);
			this.#browser = browser;
			if (!running) await this.#claimRestored(browser);
			return browser;
		})().finally(() => {
			this.#connecting = undefined;
		}));
		const browser = await connecting;
		// One that connected without starting found the browser closed; this one may start it.
		return browser ?? (start ? this.#connect(start) : undefined);
	}

	/**
	 * Chrome opens the windows it had when it starts (so that sign-ins that
	 * last only for the session stay), with new ids: each chat's window is
	 * the one where it was, and the others close.
	 */
	async #claimRestored(browser: Browser): Promise<void> {
		const records = this.#records();
		const unclaimed = Object.entries(records).sort(([, a], [, b]) => b.usedAt - a.usedAt);
		for (const [, record] of unclaimed) record.target = null;
		for (const page of await browser.pages()) {
			const owner = unclaimed.find(([, record]) => record.target === null && record.url === page.url());
			if (owner) owner[1].target = targetIdOf(page.target());
			else await page.close().catch(() => {});
		}
		this.#saveRecords(records);
	}

	/**
	 * Has the browser save downloads to the person's files, and tell the
	 * space about them, for as long as the space is connected to it.
	 */
	async #downloadToFiles(browser: Browser): Promise<void> {
		await this.#computer.fs.mkdir(DOWNLOADS, { recursive: true });
		const folder = await this.#computer.localPath(DOWNLOADS);
		const session = await browser.target().createCDPSession();
		session.on("Browser.downloadWillBegin", (event) => {
			const { guid, frameId, suggestedFilename } = event as { guid: string; frameId: string; suggestedFilename: string };
			this.#downloads.set(guid, { name: suggestedFilename, frame: frameId, startedAt: Date.now(), state: "inProgress", path: null });
		});
		session.on("Browser.downloadProgress", (event) => {
			const { guid, state, filePath } = event as { guid: string; state: Download["state"]; filePath?: string };
			const download = this.#downloads.get(guid);
			if (!download) return;
			download.state = state;
			// Chrome names the file itself (adding " (1)" beside one of the same name), and says where, on most systems.
			if (filePath?.startsWith(folder)) download.path = posix.join(DOWNLOADS, filePath.slice(folder.length).replaceAll("\\", "/"));
		});
		await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: folder, eventsEnabled: true });
	}

	/**
	 * Gets a page ready to use, once for as long as the space is connected
	 * to it: it hears the dialogs the page opens, and says it's the Chrome
	 * it is (headless Chrome names itself `HeadlessChrome`, which sites turn
	 * away).
	 */
	readonly #introduced = new WeakSet<Page>();
	async #prepare(browser: Browser, page: Page): Promise<void> {
		if (this.#introduced.has(page)) return;
		this.#introduced.add(page);
		page.on("dialog", (dialog) => this.#dialogs.set(page, dialog));
		// Answered by the person on the desktop, or by the space.
		clientOf(page).on("Page.javascriptDialogClosed", () => this.#dialogs.delete(page));
		const agent = await browser.userAgent();
		if (agent.includes("HeadlessChrome")) await page.setUserAgent(agent.replace("HeadlessChrome", "Chrome"));
	}

	/** Pictures of the chat's window stop: those watching hear it's gone. */
	#endScreencast(chat: string): void {
		const screencast = this.#screencasts.get(chat);
		if (!screencast) return;
		this.#screencasts.delete(chat);
		for (const [id, watcher] of screencast.watchers) {
			this.#watching.delete(id);
			watcher.closed();
		}
	}

	/** The connection ended: anyone watching hears the browser is gone. */
	#ended(): void {
		this.#pages.clear();
		this.#downloads.clear();
		for (const chat of [...this.#screencasts.keys()]) this.#endScreencast(chat);
	}

	/** Lets the connection go after a while unused, unless someone is watching; the browser itself stays open. */
	#letGoLater(): void {
		clearTimeout(this.#idle);
		this.#idle = setTimeout(() => {
			if (this.#screencasts.size > 0 || this.#busy > 0) return;
			const browser = this.#browser;
			const pages = [...this.#pages.values()];
			this.#browser = undefined;
			this.#pages.clear();
			void (async () => {
				// A dialog left open would hold its page from the next connection too, which couldn't start: it's dismissed.
				for (const page of pages) await this.#dialogs.get(page)?.dismiss().catch(() => {});
				await browser?.disconnect().catch(() => {});
			})();
		}, CONNECTION_IDLE_MS);
	}
}

/** A target's id, which puppeteer keeps to itself. */
function targetIdOf(target: Target): string {
	return (target as unknown as { _targetId: string })._targetId;
}

/** A frame's DevTools id, which puppeteer keeps to itself. */
function frameIdOf(frame: unknown): string {
	return (frame as { _id: string })._id;
}

/** A page's own DevTools session, which puppeteer keeps to itself. */
function clientOf(page: Page): CDPSession {
	return (page as unknown as { _client(): CDPSession })._client();
}

/**
 * Waits for `work`, or for the page to open a dialog, which holds `work`
 * until the dialog is answered; `work` then ends on its own.
 */
async function untilDialog(page: Page, work: Promise<unknown>): Promise<void> {
	let opened: () => void = () => {};
	const dialog = new Promise<void>((resolve) => {
		opened = resolve;
	});
	page.on("dialog", opened);
	work.catch(() => {});
	try {
		await Promise.race([work, dialog]);
	} finally {
		page.off("dialog", opened);
	}
}

/** A dialog as the agent reads it in place of the page it holds. */
function describeDialog(dialog: Dialog): string {
	const kind = { alert: "an alert", confirm: "a confirm", prompt: "a prompt", beforeunload: "a dialog asking whether to leave the page" }[dialog.type()] ?? "a dialog";
	const prompt = dialog.type() === "prompt" ? ` It asks for text${dialog.defaultValue() ? `, with “${dialog.defaultValue()}” filled in` : ""}.` : "";
	return `The page shows ${kind}: “${dialog.message()}”.${prompt} Nothing on the page can be used until it's answered: answer it with browser_dialog.`;
}

/** The page of the target with `id`, if it's open. */
async function pageOf(browser: Browser, id: string): Promise<Page | undefined> {
	const target = browser.targets().find((candidate) => targetIdOf(candidate) === id && candidate.type() === "page");
	return (await target?.page()) ?? undefined;
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
	return `${view.note ? `${view.note}\n\n` : ""}Page: ${view.title || "(no title)"}\nURL: ${url}\n\n${view.text || "(The page shows no text.)"}`;
}
