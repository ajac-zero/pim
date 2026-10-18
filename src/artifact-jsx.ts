/**
 * JSX artifacts: a React component the agent writes, compiled here to a
 * CommonJS function that the React runtime (`web/src/artifact-runtime/`)
 * mounts in the artifact's sandboxed frame. Compiling when a version is
 * written gives the agent the error to fix, and keeps to the modules the
 * runtime offers; compiling again when it's shown keeps the stored version
 * the source.
 */

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

/**
 * The compiled component as a classic script's text, safe inside
 * `<script>`: nothing in it can close the element or start a comment the
 * HTML parser would act on. The escapes mean the same in JavaScript.
 */
export function inlineScript(code: string): string {
	return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}
