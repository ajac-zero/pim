// A pi coding thread runs on the person's own models, as their chats do: the worker's `forge` role reads their providers (their own and what the admin shared, keys sealed under
// the deployment's key ring) and their ChatGPT plan through the definer functions of migration 0701, and still reads no application table of its own.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { chatgptContext } from "@pim/v2-app/chatgpt";
import { KeyringCrypto, sealString } from "@pim/v2-app/crypto";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { ownerModels } from "../src/forge-assembly.ts";
import { createStack, describeWith, type Stack } from "./support/stack.ts";

const real = describeWith(true);
const crypto = new KeyringCrypto("k1", { k1: Buffer.alloc(32, 7) });

real("the models of a pi coding thread", () => {
	let stack: Stack;
	let app: App;
	let forge: pg.Pool;
	beforeAll(async () => {
		stack = await createStack();
		app = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		forge = new pg.Pool({ connectionString: stack.url("forge"), max: 4 }).on("error", () => {});
	}, 60_000);
	afterAll(async () => {
		await forge?.end();
		await app?.db.end();
		await stack?.drop();
	});

	it("offers a person their own provider and ChatGPT plan, and another person neither", async () => {
		const ada = await app.identity.register({ username: "ada", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
		const grace = { ownerId: "o_grace" };
		await stack.admin.query("INSERT INTO pim_app.accounts (owner_id, username, role, status) VALUES ($1, 'grace', 'member', 'active')", [grace.ownerId]);
		const secret = await sealString(crypto, "sk-ada", `provider:${ada.ownerId}/pv_ada`);
		await stack.admin.query("INSERT INTO pim_app.providers (id, owner_id, kind, config, secret) VALUES ('pv_ada', $1, 'openai_compatible', $2, $3)", [ada.ownerId, JSON.stringify({ name: "Ada's", url: "http://127.0.0.1:1/v1", models: [{ id: "local" }] }), secret]);
		const plan = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000, clientId: "c", scopes: [], idToken: "", subject: "s", email: null };
		await stack.admin.query("INSERT INTO pim_app.chatgpt_credentials (owner_id, host_id, secret) VALUES ($1, 'h', $2)", [ada.ownerId, await sealString(crypto, JSON.stringify(plan), chatgptContext(ada.ownerId))]);
		const models = ownerModels(forge, crypto, {});
		const availableTo = async (ownerId: string) => (await (await models({ ownerId } as never)).getAvailable()).map((m) => `${m.provider}/${m.id}`);
		const mine = await availableTo(ada.ownerId);
		expect(mine).toContain("pv_ada/local");
		// `openai` is there only on the plan: Ada has no OpenAI key, so it is what she signed in with that makes it available.
		expect(mine.some((m) => m.startsWith("openai/"))).toBe(true);
		const theirs = await availableTo(grace.ownerId);
		expect(theirs).not.toContain("pv_ada/local");
		expect(theirs.some((m) => m.startsWith("openai/"))).toBe(false);
	});

	it("keeps the role out of the application's tables", async () => {
		await expect(forge.query("SELECT 1 FROM pim_app.providers")).rejects.toThrow(/permission denied/);
		await expect(forge.query("SELECT 1 FROM pim_app.chatgpt_credentials")).rejects.toThrow(/permission denied/);
	});
});
