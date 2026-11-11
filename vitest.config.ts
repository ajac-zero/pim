import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const live = process.env.PIM_LIVE === "1";

export default defineConfig({
	test: {
		// At most two test files at once: each workerd is 0.5-0.7 GiB and 1+ CPU, and a 2-vCPU sandbox starves with more.
		maxWorkers: 2,
		projects: [
			{
				plugins: [
					cloudflareTest({
						// The real Worker, with a Pim that talks to pi-ai's faux provider instead of Workers AI.
						main: "./test/worker.ts",
						wrangler: { configPath: "./wrangler.jsonc" },
						remoteBindings: false,
						// An 8-line memory view, so a few dozen memories exercise every level of the tree.
						// Open registration, so tests add people without invites unless they mean to.
						// Approvals as they were before majordomos, so only the tests about them script a majordomo's review.
						// The secrets of the test extension's bank connector, and the client registered for its Forge app.
						// The OAuth clients of the test Google connectors and of Gmail and Drive, Drive's Picker's key and project, and the key that encrypts connectors' credentials.
						// Spotify's client, so its sign-in is tested as the deployment offers it.
						// A content origin, so public app links are on.
						// Traces with their content, so the tests check what an operator who opts in would see.
						// A local Chrome, which the tests' computers browse with (test/helpers.ts's `testBrowser`).
						miniflare: {
							browserRendering: { binding: "BROWSER" },
							bindings: {
								PIM_PUBLIC_URL: "https://pim.test",
								PIM_TIME_ZONE: "America/New_York",
								PIM_MEMORY_LINES: "8",
								PIM_REGISTRATION: "open",
								PIM_APPROVAL_POLICY: "auto",
								PIM_CONTENT_ORIGIN: "https://content.pim.test",
								// Apps with a backend at subdomains of it.
								PIM_APPS_ORIGIN: "https://apps.pim.test",
								TEST_BANK_CLIENT_ID: "bank-client",
								TEST_BANK_CLIENT_SECRET: "bank-secret",
								TEST_FORGE_CLIENT_ID: "forge-client",
								TEST_FORGE_CLIENT_SECRET: "forge-secret",
								TEST_GMAIL_CLIENT_ID: "gmail-client",
								TEST_GMAIL_CLIENT_SECRET: "gmail-secret",
								TEST_DRIVE_CLIENT_ID: "drive-client",
								TEST_DRIVE_CLIENT_SECRET: "drive-secret",
								GOOGLE_GMAIL_CLIENT_ID: "real-gmail-client",
								GOOGLE_GMAIL_CLIENT_SECRET: "real-gmail-secret",
								GOOGLE_DRIVE_CLIENT_ID: "real-drive-client",
								GOOGLE_DRIVE_CLIENT_SECRET: "real-drive-secret",
								GOOGLE_DRIVE_API_KEY: "picker-key",
								GOOGLE_DRIVE_APP_ID: "123456789012",
								APP_CREDENTIALS_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
								SPOTIFY_CLIENT_ID: "spotify-client",
								SPOTIFY_CLIENT_SECRET: "spotify-secret",
								OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true",
							},
						},
					}),
				],
				test: {
					name: "worker",
					// Sandboxes and CI runners have 2 vCPUs and the Worker pool runs Durable Objects in workerd, so
					// a test that takes 3 s on a laptop takes 20+ s under load; failures at 20 s were contention, not bugs.
					testTimeout: 60_000,
					hookTimeout: 60_000,
					// The Worker test files share one workerd and its Durable Objects (the Directory, the scheduler, the
					// test Pim names), so two of them at once can interfere: settings one file changes, spaces it erases,
					// claims of the Pim. Two halves of people.test.ts run together failed in different places each time
					// (3 to 7 tests), and clean when run one at a time in about the same total time.
					fileParallelism: false,
					// Live checks against real third-party servers need the network: `pnpm test:live`.
					include: live ? ["test/live/**/*.test.ts"] : ["test/*.test.ts"],
					exclude: ["test/*.node.test.ts"],
				},
			},
			{
				// What starts real processes, which workerd can't: the computer's supervisor of apps.
				// Their waits poll for the real condition with a 30 s deadline, so a starved 2-vCPU CI runner
				// (next to the Worker project) can be slow without failing; the test timeout is above it.
				test: { name: "node", testTimeout: 60_000, include: live ? [] : ["test/*.node.test.ts"] },
			},
		],
	},
});
