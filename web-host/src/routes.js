/**
 * What the backend answers, by path prefix, as the proxy in front of Pim must route it: everything else is the web app's, which the web host serves.
 * Caddy (`deploy/compose/caddy/Caddyfile`), the Kubernetes ingress (`deploy/k8s/base/ingress.yaml`) and the development preview (`scripts/v2-dev/preview.mjs`) each
 * carry this list, and a test (`packages/v2-ops/test/deploy.test.ts`) fails when one differs. A prefix names a path or what is under it.
 * The live and relay sockets under `/api` go to their own roles by longer prefixes (`/api/ws`, ...); all of `/api` is the backend's.
 */
export const BACKEND_PATHS = [
	"/api",
	"/auth",
	"/health",
	"/install.sh",
	"/mcp",
	"/oauth",
	"/.well-known",
	"/images",
	"/app-pages",
	"/hosted",
	"/p",
	"/snapshot",
	"/live",
	"/__dev",
	// What a computer downloads to run and update itself: it must match the backend it pairs with, so the backend serves it, not the web app.
	"/pim-computer.ts",
	"/pim-host.ts",
	"/triggers-host.ts",
	"/triggers-runtime.ts",
	"/triggers-adapters",
	"/displayd.tar.gz",
];

/** Whether a request path belongs to the backend. */
export const isBackendPath = (path) => BACKEND_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
