/**
 * The automation adapter (../agent-preview-automation.ts) against the contract in the auth branch's
 * docs/preview-automation.md at 67e338f6, as a document: values below are that page's. The backend itself is not run.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentPreviewError } from "../agent-preview.ts";
import { AUTOMATION_COOKIE, AUTOMATION_PATH, parseAutomationConfig } from "../agent-preview-automation.ts";

const CREDENTIAL = "A".repeat(20) + "b-_" + "9".repeat(20);
const config = { version: 1, origin: "https://pim-cua-eval.ajac-zero.com", owner: "o_87r9p7fs0qkbs5e5q0qzetztdn", evaluation: "cua-eval-test", deployment: "cua-eval@cloudflare", credential: CREDENTIAL };
const text = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...config, ...overrides });
const session = (overrides: Record<string, unknown> = {}) => ({ kind: "automation", access: "read-only", owner: config.owner, username: "ada", evaluation: config.evaluation, deployment: config.deployment, origin: config.origin, expiresAt: "2026-10-29T12:30:00.000Z", notAfter: "2026-10-30T01:20:50.000Z", ...overrides });

describe("the automation configuration", () => {
	it("parses exactly the file the grant script writes", () => {
		assert.equal(CREDENTIAL.length, 43);
		const parsed = parseAutomationConfig(text());
		assert.equal(parsed.origin, config.origin);
		assert.deepEqual(parsed.secrets, [CREDENTIAL]);
	});

	it("refuses every field that isn't exactly its format, and says nothing of the content", () => {
		const bad: Record<string, unknown>[] = [
			{ version: 2 },
			{ origin: "http://pim-cua-eval.ajac-zero.com" },
			{ origin: "https://pim-cua-eval.ajac-zero.com/" },
			{ owner: "o_short" },
			{ owner: "O_87r9p7fs0qkbs5e5q0qzetztdn" },
			{ evaluation: "x" },
			{ deployment: "cloudflare" },
			{ credential: CREDENTIAL.slice(1) },
			{ credential: `${CREDENTIAL}=` },
			{ credential: 5 },
			{ extra: "field" },
		];
		for (const overrides of bad) {
			assert.throws(
				() => parseAutomationConfig(text(overrides)),
				(error: unknown) => error instanceof AgentPreviewError && error.code === "config" && !error.message.includes(CREDENTIAL) && !error.message.includes("pim-cua-eval"),
				JSON.stringify(Object.keys(overrides)),
			);
		}
		const missing = { ...config } as Record<string, unknown>;
		delete missing.owner;
		for (const raw of [JSON.stringify(missing), "not json", "[]", "null", `"${CREDENTIAL}"`]) {
			assert.throws(() => parseAutomationConfig(raw), (error: unknown) => error instanceof AgentPreviewError && error.code === "config" && !error.message.includes(CREDENTIAL));
		}
	});
});

describe("the exchange", () => {
	const { adapter } = parseAutomationConfig(text());

	it("posts to the contract's route with the credential only in Authorization, and the three identity fields as the body", () => {
		assert.equal(adapter.path, "/auth/automation/session");
		assert.equal(AUTOMATION_PATH, adapter.path);
		assert.equal(adapter.cookieName, "__Host-pim-automation");
		assert.equal(AUTOMATION_COOKIE, adapter.cookieName);
		const { headers, data } = adapter.request();
		assert.equal(headers?.authorization, `Pim-Automation ${CREDENTIAL}`);
		assert.deepEqual(data, { owner: config.owner, evaluation: config.evaluation, deployment: config.deployment });
		assert.equal(JSON.stringify(data).includes(CREDENTIAL), false);
	});

	it("accepts only a 201 that describes this read-only session, and reads its ISO expiry", () => {
		assert.deepEqual(adapter.accept(201, { mode: "enabled", session: session() }), { expiresAt: Date.UTC(2026, 9, 29, 12, 30) });
		const refused: [number, unknown][] = [
			[200, { mode: "enabled", session: session() }],
			[401, { error: "That automation credential isn't valid for this preview." }],
			[201, { mode: "disabled", session: session() }],
			[201, { mode: "enabled", session: null }],
			[201, { mode: "enabled", session: session({ access: "read-write" }) }],
			[201, { mode: "enabled", session: session({ kind: "passkey" }) }],
			[201, { mode: "enabled", session: session({ owner: "o_other" }) }],
			[201, { mode: "enabled", session: session({ evaluation: "other-eval" }) }],
			[201, { mode: "enabled", session: session({ deployment: "cua-eval@celld" }) }],
			[201, { mode: "enabled", session: session({ origin: "https://elsewhere.example.test" }) }],
			[201, { mode: "enabled", session: session({ expiresAt: 1790000000000 }) }],
			[201, { mode: "enabled", session: session({ expiresAt: "tomorrow" }) }],
			[201, null],
			[201, "text"],
		];
		for (const [status, body] of refused) assert.equal(adapter.accept(status, body), null, JSON.stringify(body));
	});
});
