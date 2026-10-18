/**
 * Builds the scripts artifacts run on into dist/artifact-runtime/, after the
 * app's own build: Mermaid, which draws diagrams. Each is one classic
 * script, because a sandboxed frame has an opaque origin and module scripts
 * would need CORS.
 */
import { fileURLToPath } from "node:url";
import { build } from "vite";

const web = fileURLToPath(new URL("..", import.meta.url));
const out = `${web}dist/artifact-runtime`;

const runtimes = [{ name: "mermaid", entry: "src/artifact-runtime/mermaid.ts" }];

for (const { name, entry } of runtimes) {
  await build({
    root: web,
    configFile: false,
    logLevel: "warn",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: out,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      lib: {
        entry: `${web}${entry}`,
        formats: ["iife"],
        name: `__pimRuntime_${name}`,
        fileName: () => `${name}.js`,
      },
    },
  });
}
