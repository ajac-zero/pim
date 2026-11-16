import { withTenant } from "../../src/db.ts";
import { provisionTenant } from "../../src/partitions.ts";
import { createApiToken, createSession, authenticate } from "../../src/auth.ts";
import type { TestDb } from "./db.ts";
import { newTenant } from "./storage.ts";

export async function tenantWithPeople(db: TestDb) {
	const tenantId = newTenant();
	await provisionTenant(db.maint, tenantId);
	await withTenant(db.gate, tenantId, async (q) => {
		await q.run("INSERT INTO app.users (tenant_id, user_id, username, role) VALUES ($1, 'admin', 'admin', 'admin'), ($1, 'ada', 'ada', 'member'), ($1, 'gus', 'gus', 'guest')", tenantId);
	});
	const login = async (userId: string) => (await authenticate(db.gate, tenantId, await createSession(db.gate, tenantId, userId)))!;
	return { tenantId, login, token: async (userId: string, scopes: string[]) => createApiToken(db.gate, { tenantId, userId, name: "t", scopes }) };
}
