/**
 * The page an app's version is shown in, framed in the web app's canvas or opened at its published address. It is sandboxed (an opaque origin: no cookies,
 * storage or API of Pim's, nothing to connect to), and runs with the bridge (`window.pim`, answered by `app-bridge.ts` through the frame's parent) added
 * first. An HTML app has its own scripts, styles and images put inline, since a sandboxed page can load nothing; a JSX app is compiled and runs on the
 * runtime scripts the web build makes (`web/dist/artifact-runtime/`), the only scripts a page may load.
 */
import { compileJsxApp, dataUrl, inlineCssUrls, inlineScript, resolvePath } from "@pim/v2-app/jsx";
import { BadRequestError } from "@pim/v2-app/errors";
import type { Reply } from "@pim/v2-app/http";
import type { Files } from "./admin-util.ts";

export const RUNTIME_PATH = "/artifact-runtime/";

/** Headers for any response that carries an app's page: HTML in it can only ever run sandboxed, and `runtime` lets it load Pim's own runtime scripts. */
export function frameHeaders(origin: string, options: { runtime?: boolean } = {}): Record<string, string> {
	return {
		"content-type": "text/html; charset=utf-8",
		"content-security-policy": [
			"sandbox allow-scripts",
			"default-src 'none'",
			options.runtime ? `script-src 'unsafe-inline' ${origin}${RUNTIME_PATH}` : "script-src 'unsafe-inline'",
			"style-src 'unsafe-inline'",
			"img-src data: blob:",
			"font-src data:",
			"media-src data: blob:",
			"connect-src 'none'",
			"form-action 'none'",
			"base-uri 'none'",
			`frame-ancestors ${origin}`,
		].join("; "),
		"cache-control": "no-store, private",
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"cross-origin-resource-policy": "same-origin",
		"permissions-policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=(), payment=(), publickey-credentials-get=(), publickey-credentials-create=()",
	};
}

/** Reports the page's height to the app that shows it. Added after the app's own markup, so it can't change how the document is parsed. */
export const RESIZE_SCRIPT = `<script>(()=>{let last=-1;const post=()=>{const h=Math.ceil(document.documentElement.scrollHeight);if(h!==last){last=h;parent.postMessage({type:"pim:artifact-height",height:h},"*")}};addEventListener("load",post);new ResizeObserver(post).observe(document.documentElement);post()})()</script>`;

/**
 * `window.pim`: its calls are messages to the web app that frames the page (`ArtifactFrame`), which asks Pim and the person. It answers only messages from
 * the frame's parent. A page open on its own, with no app around it, gets failed calls. In the app it also keeps the page's moves within itself (`#section`
 * links, `history.pushState`) out of the browser's history, which the frame shares with the web app.
 */
export const BRIDGE_SCRIPT = `<script>(()=>{let next=0;const waiting=new Map();const alone=parent===window;if(!alone){const replace=history.replaceState.bind(history);history.pushState=(state,title,url)=>replace(state,title,url);addEventListener("click",(event)=>{const link=event.target instanceof Element?event.target.closest("a[href]"):null;if(event.defaultPrevented||!link||typeof link.href!=="string"||(link.target&&link.target!=="_self"))return;const [page,hash]=link.href.split("#");if(hash===undefined||page!==location.href.split("#")[0])return;event.preventDefault();location.replace(link.href)})}addEventListener("message",(event)=>{if(event.source!==parent)return;const data=event.data;if(!data||data.type!=="pim:reply"||!waiting.has(data.id))return;const [resolve,reject]=waiting.get(data.id);waiting.delete(data.id);if(data.error!==undefined)reject(new Error(String(data.error)));else resolve(data.value)});const call=(op,args)=>alone?Promise.reject(new Error("Pim isn't here: this page is open on its own.")):new Promise((resolve,reject)=>{const id=++next;waiting.set(id,[resolve,reject]);parent.postMessage({type:"pim:call",id,op,args},"*")});const store=(scope)=>Object.freeze({get:(key)=>call(scope+".get",{key}),set:(key,value)=>call(scope+".set",{key,value}),delete:(key)=>call(scope+".delete",{key}),list:(prefix)=>call(scope+".list",{prefix})});window.pim=Object.freeze({storage:store("storage"),shared:store("shared"),ask:(prompt)=>call("model.ask",{prompt}),tools:Object.freeze({call:(name,input)=>call("tools.call",{name,input})})})})()</script>`;

const PAGE_HEAD =
	'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
	"<style>html,body{margin:0;background:#fff}body{font:14px/1.5 system-ui,sans-serif}</style>" +
	BRIDGE_SCRIPT;

/** An HTML app with the bridge added first: after its doctype, so the page keeps standards mode, and before everything else of its own. */
function withBridge(content: string): string {
	const doctype = /^\s*<!doctype[^>]*>/i.exec(content);
	return doctype ? doctype[0] + BRIDGE_SCRIPT + content.slice(doctype[0].length) : BRIDGE_SCRIPT + content;
}

/**
 * A page with what it loads of its own files put inline, since a sandboxed page can load nothing: scripts become inline scripts, stylesheets `<style>`
 * (their `url()`s `data:` URLs), and images, media and icons `data:` URLs. What names no file of its own is left alone, and blocked.
 */
function inlineOwnFiles(html: string, files: Files): string {
	const own = (ref: string) => {
		if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(ref.trim())) return undefined;
		const path = resolvePath("index.html", ref.trim().split(/[?#]/)[0]!);
		return path !== null && path in files ? path : undefined;
	};
	const value = String.raw`(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`;
	const attr = (name: string) => new RegExp(String.raw`(\b${name}=)${value}`, "gi");
	const dataAttrs = (tag: string, name: string) => tag.replace(attr(name), (whole, prefix, q1, q2, q3) => {
		const path = own(q1 ?? q2 ?? q3);
		return path ? `${prefix}"${dataUrl(path, files[path]!)}"` : whole;
	});
	return html
		.replace(new RegExp(String.raw`<script\b([^>]*?)\bsrc=${value}([^>]*)></script>`, "gi"), (whole, a, q1, q2, q3, b) => {
			const path = own(q1 ?? q2 ?? q3);
			return path ? `<script${a}${b}>${inlineScript(files[path]!)}</script>` : whole;
		})
		.replace(new RegExp(String.raw`<link\b[^>]*\bhref=${value}[^>]*>`, "gi"), (whole, q1, q2, q3) => {
			const path = own(q1 ?? q2 ?? q3);
			if (!path) return whole;
			if (/\brel=["']?stylesheet/i.test(whole)) return `<style>${inlineCssUrls(files[path]!, path, files).replace(/<\/(style)/gi, "<\\/$1")}</style>`;
			return /\brel=["']?[^"'>]*icon/i.test(whole) ? dataAttrs(whole, "href") : whole;
		})
		.replace(/<(img|source|audio|video)\b[^>]*>/gi, (tag) => dataAttrs(dataAttrs(tag, "src"), "poster"));
}

/** The page a version is shown as: an HTML app as it is, a JSX one compiled after the React runtime and the modules it imports. Each ends with the height script. */
export function framePage(kind: string, files: Files, origin: string, options: { thumbnail?: boolean } = {}): Reply {
	const thumbnail = options.thumbnail ? `<script src="${origin}${RUNTIME_PATH}thumbnail.js"></script>` : "";
	const page = (body: string, runtime = false): Reply => ({ status: 200, headers: frameHeaders(origin, { runtime: runtime || options.thumbnail === true }), raw: body + RESIZE_SCRIPT + thumbnail });
	if (kind === "html") return page(withBridge(inlineOwnFiles(files["index.html"] ?? "", files)));
	if (kind === "jsx") {
		const entry = ["App.jsx", "App.tsx"].find((m) => m in files);
		if (!entry) throw new BadRequestError("A JSX app's main file is App.jsx or App.tsx");
		const { code, runtimes } = compileJsxApp(files, entry);
		const scripts = [...runtimes, "tailwind"].map((name) => `<script src="${origin}${RUNTIME_PATH}${name}.js"></script>`).join("");
		return page(`${PAGE_HEAD}</head><body><div id="root"></div>${scripts}<script>__pimMount(function (require, module, exports) {\n${inlineScript(code)}\n})</script></body></html>`, true);
	}
	return page(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:16px;color:#555">An app with a backend opens at its own address.</body>`);
}
