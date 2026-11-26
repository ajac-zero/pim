import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * In development, `/api` goes to a running Pim (the preview, `node scripts/v2-dev/preview.mjs`)
 * with an API token you made in Settings, so you're
 * signed in as yourself without a passkey:
 *
 *   PIM_API_TOKEN=... pnpm dev:web
 *
 * Set PIM_API_URL to use another Pim. The token stays in this process; the
 * browser never sees it.
 */
/** Pim's version, shown in the sidebar. */
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), "PIM_"), ...process.env };
  const target = env.PIM_API_URL ?? "http://localhost:8787";
  const token = env.PIM_API_TOKEN;

  // Names this build of the app by its source, so what an older one kept on a device is dropped (see `saved-queries.ts`).
  const build = createHash("sha256");
  const source = new URL("./src/", import.meta.url);
  for (const file of readdirSync(source, {
    recursive: true,
    encoding: "utf8",
  }).sort()) {
    const path = new URL(file, source);
    // The route tree is made from the routes, and only during a build.
    if (file === "routeTree.gen.ts" || !statSync(path).isFile()) continue;
    build.update(file).update(readFileSync(path));
  }

  const buildId = build.digest("hex").slice(0, 16);

  return {
    define: {
      __PIM_VERSION__: JSON.stringify(version),
      "import.meta.env.PIM_BUILD": JSON.stringify(buildId),
    },
    server: {
      port: 3000,
      host: true,
      allowedHosts: true,
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
          ws: true,
          headers: token ? { authorization: `Bearer ${token}` } : {},
        },
      },
    },
    resolve: {
      tsconfigPaths: true,
    },
    plugins: [
      {
        // The proxy signs you in with the token, so there are no passkeys here.
        name: "pim-dev-session",
        configureServer(server) {
          server.middlewares.use("/auth/session", (_request, response) => {
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify({
                signedIn: true,
                method: "dev",
                passkey: null,
                account: null,
              }),
            );
          });
        },
      },
      {
        // What this build says of itself, for the page that asks (`/release.json`) and for the web host that publishes
        // it as a release of its own (web-host/).
        name: "pim-release",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "release.json",
            source: JSON.stringify({
              id: buildId,
              version,
              ...(env.PIM_REVISION ? { revision: env.PIM_REVISION } : {}),
              builtAt: new Date().toISOString(),
            }),
          });
        },
      },
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      viteReact(),
      tailwindcss(),
    ],
  };
});
