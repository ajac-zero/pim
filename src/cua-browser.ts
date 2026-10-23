import { Buffer } from "node:buffer";
import type { AgentBrowser, ElementDescription, PageView } from "./browser";
import type { CuaEvaluation, DriverAnswer } from "./cua";

/**
 * The agents' browser on the Cua evaluation computer (./cua.ts): Chromium
 * with an isolated profile of cua-driver's, named `pim`, which keeps what
 * the person signs in to there, driven with cua-driver's typed browser tools
 * (bind the window, snapshot the tab, navigate, click and type by the
 * snapshot's refs), never over a DevTools connection of Pim's.
 *
 * It is one tab, which every chat shares, unlike the space's own browser,
 * which gives each chat a window. Pages read as the driver's semantic
 * outline, with what can be clicked or typed into numbered as the browser
 * tools expect: `[12 button “Search”]`. Numbers keep counting up and each
 * stands for one ref of one snapshot, which a newer snapshot or a
 * navigation ends, so a number that waited for the person's approval
 * reaches the element it named or none. Each use is one piece of work for
 * the evaluation's pause (`CuaEvaluation.hold`).
 */

/** The driver session, and the isolated profile, Pim's browser uses; the bridge accepts no other. */
const SESSION = "pim";
const KEPT_KEY = "cua_browser";
const MAX_PAGE_CHARS = 12_000;
const MAX_REFS = 300;
/** How long a click or typing gets to set off what it does before the page is read again. */
const SETTLE_MS = 400;
/** Refusals that mean the binding is gone: the browser closed, its session ended or the tab went. */
const UNBOUND = new Set(["browser_binding_stale", "browser_tab_not_found", "browser_reconnect_exhausted", "browser_requires_setup", "browser_wrong_target_refused", "error"]);

type Binding = { readonly targetId: string; readonly tabId: string };
type Ref = { readonly ref: string; readonly role: string; readonly name: string };
type Kept = { binding: Binding | null; page: { url: string; title: string; refs: Record<string, Ref> } | null; next: number };
type Meta = { get(key: string): string | null; set(key: string, value: string | null): void };

class Refused extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`The Cua browser refused (${code}): ${message.slice(0, 300)}`);
		this.code = code;
	}
}

const NO_SUCH_REF = (ref: number) => `There is no [${ref}] on the page now. Read the page again with browser_read and use a number it shows.`;
const CLOSED = "Your window has closed since. Open the page again with browser_open.";

function hostOf(url: string): string {
	try {
		return new URL(url).host || url.slice(0, 40);
	} catch {
		return url.slice(0, 40);
	}
}

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});

export class CuaBrowser implements AgentBrowser {
	readonly #cua: CuaEvaluation;
	readonly #meta: Meta;

	constructor(cua: CuaEvaluation, meta: Meta) {
		this.#cua = cua;
		this.#meta = meta;
	}

	#kept(): Kept {
		const kept = this.#meta.get(KEPT_KEY);
		return kept ? (JSON.parse(kept) as Kept) : { binding: null, page: null, next: 1 };
	}

	#save(kept: Kept): void {
		this.#meta.set(KEPT_KEY, JSON.stringify(kept));
	}

	#forget(): void {
		this.#save({ ...this.#kept(), binding: null });
	}

	/** One driver tool; a refusal is thrown, with its code. */
	async #call(tool: string, args: Record<string, unknown>): Promise<DriverAnswer> {
		const answer = await this.#cua.driver(tool, args);
		const structured = record(answer.structured);
		if (structured.status === "refused") {
			const refusal = record(structured.refusal);
			throw new Refused(String(refusal.code ?? "refused"), String(refusal.message ?? answer.text));
		}
		if (answer.isError) throw new Refused("error", answer.text || "it failed");
		return answer;
	}

	/** The tab Pim's browser uses: bound already, or bound now, starting the isolated browser if it isn't running. */
	async #bind(): Promise<Binding> {
		const kept = this.#kept();
		if (kept.binding) return kept.binding;
		await this.#call("start_session", { session: SESSION });
		const prepared = record((await this.#call("browser_prepare", { session: SESSION, allow_launch: true, profile: { mode: "isolated_named", name: SESSION } })).structured);
		const pid = prepared.prepared_pid;
		if (typeof pid !== "number") throw new Error("The Cua browser didn't start.");
		const windows = (record((await this.#call("list_windows", { pid })).structured).windows ?? []) as Record<string, unknown>[];
		const window = windows.filter((each) => typeof each.window_id === "number").sort((a, b) => Number(b.z_index ?? -1) - Number(a.z_index ?? -1))[0];
		if (!window) throw new Error("The Cua browser has no window yet. Try again in a moment.");
		const bound = record((await this.#call("get_browser_state", { session: SESSION, pid, window_id: window.window_id })).structured);
		if (bound.binding_quality !== "exact" || typeof bound.target_id !== "string") throw new Error("The Cua browser's window couldn't be bound exactly, so Pim won't act in it.");
		const tabs = (Array.isArray(bound.tabs) ? bound.tabs : []) as Record<string, unknown>[];
		const tab = tabs.find((each) => each.active === true) ?? tabs[0];
		if (typeof tab?.tab_id !== "string") throw new Error("The Cua browser's window has no tab.");
		const binding = { targetId: bound.target_id, tabId: tab.tab_id };
		this.#save({ ...this.#kept(), binding });
		return binding;
	}

	/** Reads the tab: its outline, with numbers for what can be acted on, and a picture of it if asked. */
	async #snapshot(binding: Binding, picture = false): Promise<{ view: PageView; image: string | null }> {
		const answer = await this.#call("get_browser_state", {
			session: SESSION,
			target_id: binding.targetId,
			tab_id: binding.tabId,
			snapshot_format: "semantic_v2",
			...(picture ? { include_screenshot: true } : {}),
		});
		const structured = record(answer.structured);
		const page = record(structured.page);
		const kept = this.#kept();
		let next = kept.next;
		const refs: Record<string, Ref> = {};
		const lines: string[] = [];
		for (const each of (Array.isArray(structured.refs) ? structured.refs : []).slice(0, MAX_REFS) as Record<string, unknown>[]) {
			if (typeof each.ref !== "string") continue;
			const ref = { ref: each.ref, role: String(each.role ?? "element"), name: String(each.name ?? "").replace(/\s+/g, " ").slice(0, 80) };
			refs[next] = ref;
			lines.push(`[${next} ${ref.role} “${ref.name}”]`);
			next++;
		}
		const outline = String(structured.outline ?? "");
		const text = [
			outline.length > MAX_PAGE_CHARS ? `${outline.slice(0, MAX_PAGE_CHARS)}\n[The page goes on; this is its first ${MAX_PAGE_CHARS} characters.]` : outline,
			...(lines.length > 0 ? [`What you can click or type into, by number:\n${lines.join("\n")}`] : []),
		]
			.filter(Boolean)
			.join("\n\n");
		const shown = { url: String(page.url ?? ""), title: String(page.title ?? "") };
		this.#save({ binding, page: { ...shown, refs }, next });
		return { view: { ...shown, text }, image: answer.image };
	}

	/** What a failed use says to the model: a stale number, a window gone (which is forgotten), or the driver's refusal. */
	#explain(error: unknown, ref?: number): Error {
		if (!(error instanceof Refused)) return error instanceof Error ? error : new Error(String(error));
		if (ref !== undefined && (error.code === "browser_ref_stale" || error.code === "browser_action_unavailable")) return new Error(NO_SUCH_REF(ref));
		if (UNBOUND.has(error.code)) {
			this.#forget();
			return new Error(CLOSED);
		}
		return error;
	}

	visit(_chat: string, url: string): Promise<PageView> {
		if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error("The Cua evaluation's browser opens http(s) addresses only."));
		return this.#cua.hold(async () => {
			let binding = await this.#bind();
			try {
				await this.#call("browser_navigate", { session: SESSION, target_id: binding.targetId, tab_id: binding.tabId, url });
			} catch (error) {
				if (!(error instanceof Refused) || !UNBOUND.has(error.code)) throw error;
				// The browser went since it was bound: once more, in a new one.
				this.#forget();
				binding = await this.#bind();
				await this.#call("browser_navigate", { session: SESSION, target_id: binding.targetId, tab_id: binding.tabId, url });
			}
			return (await this.#snapshot(binding)).view;
		});
	}

	read(_chat: string): Promise<PageView | null> {
		return this.#cua.hold(async () => {
			const { binding } = this.#kept();
			if (!binding) return null;
			try {
				return (await this.#snapshot(binding)).view;
			} catch (error) {
				if (this.#explain(error).message === CLOSED) return null;
				throw error;
			}
		});
	}

	/** From the last read, so nothing on the machine is touched to ask the person about it. */
	async describe(_chat: string, ref: number): Promise<ElementDescription | null> {
		const { page } = this.#kept();
		const found = page?.refs[ref];
		if (!page || !found) return null;
		return { host: hostOf(page.url), label: found.name ? `the ${found.role} “${found.name}”` : `a ${found.role} with no name` };
	}

	#target(ref: number): { binding: Binding; ref: string } {
		const { binding, page } = this.#kept();
		if (!binding) throw new Error(CLOSED);
		const found = page?.refs[ref];
		if (!found) throw new Error(NO_SUCH_REF(ref));
		return { binding, ref: found.ref };
	}

	click(_chat: string, ref: number): Promise<PageView> {
		return this.#cua.hold(async () => {
			const target = this.#target(ref);
			const { targetId, tabId } = target.binding;
			try {
				await this.#call("browser_click", { session: SESSION, target_id: targetId, tab_id: tabId, ref: target.ref, delivery_mode: "foreground" });
			} catch (error) {
				throw this.#explain(error, ref);
			}
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
			return (await this.#snapshot(target.binding)).view;
		});
	}

	type(_chat: string, ref: number, text: string, submit: boolean): Promise<PageView> {
		return this.#cua.hold(async () => {
			const target = this.#target(ref);
			const at = { session: SESSION, target_id: target.binding.targetId, tab_id: target.binding.tabId, ref: target.ref };
			try {
				await this.#call("browser_type", { ...at, text, replace: true });
				if (submit) await this.#call("browser_type", { ...at, text: "\n", mode: "keystrokes" });
			} catch (error) {
				throw this.#explain(error, ref);
			}
			await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
			return (await this.#snapshot(target.binding)).view;
		});
	}

	/** A picture of the tab. It reads the tab again too, so numbers from before it are gone: read the page again after. */
	screenshot(_chat: string): Promise<Uint8Array | null> {
		return this.#cua.hold(async () => {
			const { binding } = this.#kept();
			if (!binding) return null;
			const { image } = await this.#snapshot(binding, true).catch((error) => {
				throw this.#explain(error);
			});
			return image ? new Uint8Array(Buffer.from(image, "base64")) : null;
		});
	}

	/** Ends the driver session, which closes the browser; its named profile, with what's signed in there, stays. */
	close(_chat: string): Promise<void> {
		return this.#cua.hold(async () => {
			if (this.#kept().binding) await this.#call("end_session", { session: SESSION }).catch(() => undefined);
			this.#save({ ...this.#kept(), binding: null, page: null });
		});
	}

	/** The page the tab showed when last read; nothing on the machine is asked. */
	current(): { url: string; title: string } | null {
		const { page } = this.#kept();
		return page ? { url: page.url, title: page.title } : null;
	}
}
