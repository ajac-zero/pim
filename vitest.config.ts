import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const live = process.env.PIM_LIVE === "1";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// The real Worker, with a Pim that talks to pi-ai's faux provider instead of Workers AI.
			main: "./test/worker.ts",
			wrangler: { configPath: "./wrangler.jsonc" },
			remoteBindings: false,
			// An 8-line memory view, so a few dozen memories exercise every level of the tree.
			// Open registration, so tests add people without invites unless they mean to.
			// Approvals as they were before majordomos, so only the tests about them script a majordomo's review.
			// The secrets of the test extension's bank app, and the client registered for its Forge app.
			// The OAuth clients of the test Google apps and of Gmail and Drive, Drive's Picker's key and project, and the key that encrypts apps' credentials.
			// Spotify's client, so its sign-in is tested as the deployment offers it.
			// A content origin, so public artifact links are on.
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
		testTimeout: 20_000,
		// Live checks against real third-party servers need the network: `pnpm test:live`.
		include: live ? ["test/live/**/*.test.ts"] : ["test/*.test.ts"],
	},
});
