/**
 * JSX artifacts: a React component the agent writes, compiled here to a
 * CommonJS function that the React runtime (`web/src/artifact-runtime/`)
 * mounts in the artifact's sandboxed frame. Compiling when a version is
 * written gives the agent the error to fix, and keeps to the modules the
 * runtime offers; compiling again when it's shown keeps the stored version
 * the source.
 */

import { Buffer } from "node:buffer";
import { transform } from "sucrase";
import { HttpError } from "./http";

/** The modules a JSX artifact may import, and the runtime file each comes from. */
const MODULES: Record<string, string> = {
	react: "react",
	"react-dom": "react",
	"react-dom/client": "react",
	"react/jsx-runtime": "react",
	recharts: "recharts",
	"lucide-react": "lucide",
};

/** What the modules are, for the agent. */
export const JSX_MODULES = ["react", "recharts", "lucide-react"] as const;

export type CompiledJsx = {
	/** The component as the body of `function (require, module, exports)`. */
	readonly code: string;
	/** The runtime files it needs, React's first. */
	readonly runtimes: readonly string[];
};

/** Compiles a JSX (or TSX) component, or refuses it (400) with what to fix. */
export function compileJsx(source: string): CompiledJsx {
	let code: string;
	try {
		code = transform(source, { transforms: ["jsx", "typescript", "imports"], jsxRuntime: "automatic", production: true }).code;
	} catch (error) {
		throw new HttpError(400, `The JSX doesn't compile: ${error instanceof Error ? error.message : String(error)}`);
	}
	const runtimes = new Set(["react"]);
	for (const [, , name] of code.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)) {
		const runtime = MODULES[name!];
		if (!runtime) throw new HttpError(400, `A JSX artifact can import only ${JSX_MODULES.join(", ")}; not "${name}".`);
		runtimes.add(runtime);
	}
	if (!/\bexports\.\s*default\s*=/.test(code)) throw new HttpError(400, "A JSX artifact must export its component as the default: export default function App() { ... }");
	return { code, runtimes: [...runtimes] };
}

/** A JSX app's files, by path, with their media types and bytes. */
type AppFiles = ReadonlyMap<string, { readonly type: string; readonly bytes: Uint8Array }>;

const CODE = /\.(jsx|tsx|js|ts|mjs)$/;
/** The files an import of `./name` may mean, in the order they're tried. */
const CANDIDATES = ["", ".jsx", ".tsx", ".js", ".ts", "/index.jsx", "/index.tsx", "/index.js", "/index.ts"];

/** A path relative to another file's folder, or null when it leaves the artifact. */
export function resolvePath(from: string, reference: string): string | null {
	const parts = from.split("/").slice(0, -1);
	for (const part of reference.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
		} else parts.push(part);
	}
	return parts.join("/");
}

/** A file as a `data:` URL, which a sandboxed page may load. */
export function dataUrl(file: { type: string; bytes: Uint8Array }): string {
	return `data:${file.type};base64,${Buffer.from(file.bytes).toString("base64")}`;
}

/** CSS with the `url(...)`s that name the artifact's own files made into `data:` URLs. */
export function inlineCssUrls(css: string, from: string, files: AppFiles): string {
	return css.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/g, (whole, _quote: string, reference: string) => {
		if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(reference)) return whole;
		const path = resolvePath(from, reference.split(/[?#]/)[0]!);
		const file = path === null ? undefined : files.get(path);
		return file ? `url("${dataUrl(file)}")` : whole;
	});
}

const decoder = new TextDecoder();

/**
 * Compiles a JSX app of several files into one script: its main file and
 * every file it imports, as modules. Code files are compiled like the main
 * one; JSON is its value; CSS adds a style to the page; anything else is
 * its `data:` URL. Imports are the runtime's modules or the app's own files,
 * by relative path; anything else is refused (400) with what to fix.
 */
export function compileJsxApp(files: AppFiles, entry: string): CompiledJsx {
	const modules = new Map<string, { code: string; imports: Record<string, string> }>();
	const runtimes = new Set(["react"]);
	const visit = (path: string) => {
		if (modules.has(path)) return;
		const file = files.get(path)!;
		const text = decoder.decode(file.bytes);
		const imports: Record<string, string> = {};
		modules.set(path, { code: "", imports });
		if (!CODE.test(path)) {
			if (path.endsWith(".json")) {
				try {
					JSON.parse(text);
				} catch {
					throw new HttpError(400, `${path} isn't valid JSON.`);
				}
				modules.get(path)!.code = `module.exports = ${text};`;
			} else if (path.endsWith(".css")) {
				modules.get(path)!.code = `const style = document.createElement("style"); style.textContent = ${JSON.stringify(inlineCssUrls(text, path, files))}; document.head.appendChild(style);`;
			} else {
				modules.get(path)!.code = `module.exports = ${JSON.stringify(dataUrl(file))};`;
			}
			return;
		}
		let code: string;
		try {
			code = transform(text, { transforms: ["jsx", "typescript", "imports"], jsxRuntime: "automatic", production: true, filePath: path }).code;
		} catch (error) {
			throw new HttpError(400, `${path} doesn't compile: ${error instanceof Error ? error.message : String(error)}`);
		}
		modules.get(path)!.code = code;
		for (const [, , name] of code.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)) {
			if (name!.startsWith("./") || name!.startsWith("../")) {
				const base = resolvePath(path, name!);
				const found = base === null ? undefined : CANDIDATES.map((suffix) => base + suffix).find((candidate) => files.has(candidate));
				if (!found) throw new HttpError(400, `${path} imports "${name}", which isn't one of the artifact's files.`);
				imports[name!] = found;
				visit(found);
				continue;
			}
			const runtime = MODULES[name!];
			if (!runtime) throw new HttpError(400, `A JSX artifact can import only ${JSX_MODULES.join(", ")} and its own files; not "${name}".`);
			runtimes.add(runtime);
		}
	};
	visit(entry);
	if (!/\bexports\.\s*default\s*=/.test(modules.get(entry)!.code)) {
		throw new HttpError(400, "A JSX artifact must export its component as the default: export default function App() { ... }");
	}
	// Each module runs once, when first imported, with a require that finds its imports among the others.
	const table = [...modules].map(([path, module]) => `${JSON.stringify(path)}: [function (require, module, exports) {\n${module.code}\n}, ${JSON.stringify(module.imports)}]`);
	const code = `const files = {${table.join(",\n")}};
const loaded = {};
const load = (path) => {
	if (loaded[path]) return loaded[path].exports;
	const module = (loaded[path] = { exports: {} });
	const [run, imports] = files[path];
	run((name) => (Object.prototype.hasOwnProperty.call(imports, name) ? load(imports[name]) : require(name)), module, module.exports);
	return module.exports;
};
module.exports = load(${JSON.stringify(entry)});`;
	return { code, runtimes: [...runtimes] };
}

/**
 * The compiled component as a classic script's text, safe inside
 * `<script>`: nothing in it can close the element or start a comment the
 * HTML parser would act on. The escapes mean the same in JavaScript.
 */
export function inlineScript(code: string): string {
	return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}
