/**
 * JSX apps: a React component the agent writes, compiled to a CommonJS function the React runtime (`web/src/artifact-runtime/`, served as static files at
 * `/artifact-runtime/`) mounts in the app's sandboxed frame. It is compiled when a version is written, so the agent gets the error to fix, and again when
 * it is shown, so the stored version stays the source. An app imports the runtime's modules and its own files; anything else is refused.
 */
import { transform } from "sucrase";
import { BINARY_PREFIX, isBinary, typeOfFile } from "./app-files.ts";
import { BadRequestError } from "./errors.ts";

/** The modules a JSX app may import, and the runtime file each comes from. */
const MODULES: Record<string, string> = { react: "react", "react-dom": "react", "react-dom/client": "react", "react/jsx-runtime": "react", recharts: "recharts", "lucide-react": "lucide" };
export const JSX_MODULES = ["react", "recharts", "lucide-react"] as const;

export type CompiledJsx = { /** The component as the body of `function (require, module, exports)`. */ code: string; /** The runtime files it needs, React's first. */ runtimes: string[] };
type Files = Record<string, string>;

const CODE = /\.(jsx|tsx|js|ts|mjs)$/;
const CANDIDATES = ["", ".jsx", ".tsx", ".js", ".ts", "/index.jsx", "/index.tsx", "/index.js", "/index.ts"];

/** A path relative to another file's folder, or null when it leaves the app. */
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

const TYPES: Record<string, string> = { css: "text/css", json: "application/json", svg: "image/svg+xml", html: "text/html", txt: "text/plain", md: "text/markdown" };
/** A file as a `data:` URL, which a sandboxed page may load. */
export const dataUrl = (path: string, content: string) =>
	isBinary(content) ? `data:${typeOfFile(path)};base64,${content.slice(BINARY_PREFIX.length)}` : `data:${TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text/plain"};base64,${Buffer.from(content).toString("base64")}`;

/** CSS with the `url(...)`s that name the app's own files made into `data:` URLs. */
export function inlineCssUrls(css: string, from: string, files: Files): string {
	return css.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/g, (whole, _quote: string, reference: string) => {
		if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(reference)) return whole;
		const path = resolvePath(from, reference.split(/[?#]/)[0]!);
		return path !== null && path in files ? `url("${dataUrl(path, files[path]!)}")` : whole;
	});
}

/** Compiles a JSX app of several files into one script: its main file and every file it imports, as modules. Refuses (400) with what to fix. */
export function compileJsxApp(files: Files, entry: string): CompiledJsx {
	const modules = new Map<string, { code: string; imports: Record<string, string> }>();
	const runtimes = new Set(["react"]);
	const visit = (path: string) => {
		if (modules.has(path)) return;
		const text = files[path]!;
		const imports: Record<string, string> = {};
		modules.set(path, { code: "", imports });
		if (!CODE.test(path)) {
			if (path.endsWith(".json")) {
				try {
					JSON.parse(text);
				} catch {
					throw new BadRequestError(`${path} isn't valid JSON.`);
				}
				modules.get(path)!.code = `module.exports = ${text};`;
			} else if (path.endsWith(".css")) modules.get(path)!.code = `const style = document.createElement("style"); style.textContent = ${JSON.stringify(inlineCssUrls(text, path, files))}; document.head.appendChild(style);`;
			else modules.get(path)!.code = `module.exports = ${JSON.stringify(dataUrl(path, text))};`;
			return;
		}
		let code: string;
		try {
			code = transform(text, { transforms: ["jsx", "typescript", "imports"], jsxRuntime: "automatic", production: true, filePath: path }).code;
		} catch (error) {
			throw new BadRequestError(`${path} doesn't compile: ${error instanceof Error ? error.message : String(error)}`);
		}
		modules.get(path)!.code = code;
		for (const [, , name] of code.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)) {
			if (name!.startsWith("./") || name!.startsWith("../")) {
				const base = resolvePath(path, name!);
				const found = base === null ? undefined : CANDIDATES.map((suffix) => base + suffix).find((candidate) => candidate in files);
				if (!found) throw new BadRequestError(`${path} imports "${name}", which isn't one of the app's files.`);
				imports[name!] = found;
				visit(found);
				continue;
			}
			const runtime = MODULES[name!];
			if (!runtime) throw new BadRequestError(`A JSX app can import only ${JSX_MODULES.join(", ")} and its own files; not "${name}".`);
			runtimes.add(runtime);
		}
	};
	visit(entry);
	if (!/\bexports\.\s*default\s*=/.test(modules.get(entry)!.code)) throw new BadRequestError("A JSX app must export its component as the default: export default function App() { ... }");
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

/** The compiled component as a classic script's text, safe inside `<script>`: nothing in it can close the element or start a comment the HTML parser would act on. */
export const inlineScript = (code: string) => code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
