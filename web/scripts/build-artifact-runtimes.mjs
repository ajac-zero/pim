/**
 * Builds the scripts artifacts run on into dist/artifact-runtime/, after the
 * app's own build: Mermaid, which draws diagrams, and React, charts, icons
 * and Tailwind for JSX artifacts. Each is one classic script, because a
 * sandboxed frame has an opaque origin and module scripts would need CORS.
 * The charts and icons use the React runtime's React, which they find in
 * `__pimModules`, so a page loads React once.
 */
import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import viteReact from "@vitejs/plugin-react";
import { build } from "vite";

const web = fileURLToPath(new URL("..", import.meta.url));
const out = `${web}dist/artifact-runtime`;

/**
 * React and its parts, as the React runtime registered them: the charts and
 * icons runtimes import these instead, and so do their dependencies that
 * `require` React, which an external global wouldn't reach.
 */
const SHARED_REACT = [
  { find: /^react$/, replacement: `${web}src/artifact-runtime/shared/react.cjs` },
  { find: /^react-dom$/, replacement: `${web}src/artifact-runtime/shared/react-dom.cjs` },
  {
    find: /^react\/jsx-runtime$/,
    replacement: `${web}src/artifact-runtime/shared/jsx-runtime.cjs`,
  },
];

const runtimes = [
  { name: "mermaid", entry: "src/artifact-runtime/mermaid.ts", shared: false },
  { name: "react", entry: "src/artifact-runtime/react.tsx", shared: false },
  { name: "recharts", entry: "src/artifact-runtime/recharts.ts", shared: true },
  { name: "lucide", entry: "src/artifact-runtime/lucide.ts", shared: true },
];

for (const { name, entry, shared } of runtimes) {
  await build({
    root: web,
    configFile: false,
    logLevel: "warn",
    plugins: [viteReact()],
    resolve: shared ? { alias: SHARED_REACT } : {},
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

// Tailwind's browser build already is one classic script.
await copyFile(
  `${web}node_modules/@tailwindcss/browser/dist/index.global.js`,
  `${out}/tailwind.js`,
);
