import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerStorageConformance, seedStorageBenchmark, STORAGE_READ_BENCHMARKS, STORAGE_WRITE_BENCHMARKS, seedStorageWriteBenchmark } from "@earendil-works/pi-durable/testing";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createTestDatabase, type TestDatabase } from "./support/pg.ts";
import { openTestPartition } from "./support/partition.ts";

let database: TestDatabase;
beforeAll(async () => {
	database = await createTestDatabase();
});
afterAll(async () => {
	await database.drop();
});

// The upstream suite: every case gets a fresh owner with a leased home partition, which is where pi's root lives.
registerStorageConformance({ describe, expect, it }, "PgPiStorage", async (use) => {
	const part = await openTestPartition(database.db);
	try {
		await use(part.storage);
	} finally {
		await part.lease.stopHeartbeat();
		await part.storage.close(BACKGROUND_CONTEXT);
	}
});

describe("upstream storage benchmark seeds", () => {
	it("seeds the shared dataset and answers every read benchmark as expected", async () => {
		const part = await openTestPartition(database.db);
		const dataset = await seedStorageBenchmark(part.storage);
		for (const benchmark of STORAGE_READ_BENCHMARKS) {
			expect(await benchmark.run(part.storage, dataset), benchmark.name).toBe(benchmark.expected(dataset));
		}
	});

	it("runs every write benchmark against the seeded state", async () => {
		const part = await openTestPartition(database.db);
		await seedStorageWriteBenchmark(part.storage);
		for (const benchmark of STORAGE_WRITE_BENCHMARKS) {
			expect(await benchmark.run(part.storage), benchmark.name).toBe(benchmark.expected);
		}
	});
});
