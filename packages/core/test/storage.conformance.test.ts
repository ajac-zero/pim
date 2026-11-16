import { createExpectAssertions, registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./support/db.ts";
import { openStorage } from "./support/storage.ts";

let db: TestDb;
beforeAll(async () => {
	db = await createTestDb();
});
afterAll(async () => db.close());

// pi's own storage contract suite, run unchanged against the PostgreSQL adapter.
registerStorageConformance({ describe, expect, it } as never, "PgStorage", async (use) => {
	const { storage } = await openStorage(db);
	try {
		await use(storage);
	} finally {
		await storage.close(undefined as never);
	}
});
void createExpectAssertions;
