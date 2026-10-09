import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

/**
 * In development, `/api` goes to Pim under `wrangler dev` (run `pnpm dev` at
 * the repository's root) with your API token, so you're signed in without a
 * passkey:
 *
 *   PIM_API_TOKEN=... pnpm dev:web
 *
 * Set PIM_API_URL to use another Pim. The token stays in this process; the
 * browser never sees it.
 */
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), "PIM_"), ...process.env };
  const target = env.PIM_API_URL ?? "http://localhost:8787";
  const token = env.PIM_API_TOKEN;

  return {
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
                hasPasskeys: false,
              }),
            );
          });
        },
      },
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      viteReact(),
      tailwindcss(),
    ],
  };
});
