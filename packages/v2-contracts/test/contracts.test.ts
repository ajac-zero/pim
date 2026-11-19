import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApprovalRequiredError, CapabilityUnavailableError, ForbiddenError, normalizeRepository, repositoryAllowed, standingApprovalCovers, type AuthzError, type StandingApproval } from "../src/authz.ts";
import { MIGRATION_BANDS, migrationOwner, parseMigrationFile, validateMigrationFiles, withTenantTransaction, type SqlPool } from "../src/db.ts";
import { codingThreadId, completionWakeId, ForgeCompletionWake, HARNESS_CAPABILITIES, HARNESS_IDS } from "../src/forge-seam.ts";
import { effectivePrincipal, OwnerId, type Principal } from "../src/identity.ts";
import { ClientFrame, compareCursors, parseCursor, pulseSubjects, serializeCursor, ServerFrame, type ProjectionCursor } from "../src/live-seam.ts";
import { loadProcessConfig, rolesOf } from "../src/platform.ts";

const owner = OwnerId.parse("o_ada");
const partition = "6f1d2c3e-0000-4000-8000-000000000001" as ProjectionCursor["partitionId"];

/** The legacy Worker's algorithm (its `digestHex` and `codingThreadId`, at the git tag `v1-final`) with WebCrypto, as it ran there. */
async function legacyCodingThreadId(space: string, operationId: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`pim coding thread\n${space}\n${operationId}`)));
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

describe("codingThreadId", () => {
	it("keeps the legacy recipe: the SHA-256 of \"pim coding thread\", the space and the operation on separate lines, cut into a UUID's groups", () => {
		// Thread ids already stored by the legacy Worker must come out the same, so these are fixed values, not recomputed ones.
		expect(codingThreadId("o_ada", "op-1")).toBe("d7adeb2f-26eb-224c-57cb-fb011bb3c94f");
		expect(codingThreadId("o_bob", "op-2")).toBe("56b06f6f-4a07-c1dc-f168-ca4e6c8ed88b");
	});
	it("matches the legacy Worker's id for the same space and operation", async () => {
		for (const [space, operation] of [["o_ada", "op-1"], ["o_ada", "op-2"], ["o_bob", "op-1"], ["o_ünï", "op\n1"]] as const) {
			expect(codingThreadId(space, operation)).toBe(await legacyCodingThreadId(space, operation));
		}
	});
	it("is a UUID-shaped id that differs by owner and by operation", () => {
		const id = codingThreadId("o_ada", "op-1");
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(codingThreadId("o_bob", "op-1")).not.toBe(id);
		expect(codingThreadId("o_ada", "op-2")).not.toBe(id);
	});
	it("has wake ids the envelopes accept", () => {
		const threadId = codingThreadId("o_ada", "op-1");
		expect(ForgeCompletionWake.safeParse({ wakeId: completionWakeId(threadId, "op-1"), threadId, operationId: "op-1", outcome: "completed" }).success).toBe(true);
		expect(ForgeCompletionWake.safeParse({ wakeId: "nope", threadId, operationId: "op-1", outcome: "completed" }).success).toBe(false);
	});
	it("describes exactly the five harnesses, and only amp needs no workspace pool", () => {
		expect([...HARNESS_IDS]).toEqual(["pi", "claude-code", "codex", "mistral-vibe", "amp"]);
		expect(HARNESS_IDS.filter((id) => !HARNESS_CAPABILITIES[id].requiresWorkspacePool)).toEqual(["amp"]);
	});
});

describe("cursors", () => {
	const at = (commitSeq: bigint, projectionVersion = 1): ProjectionCursor => ({ partitionId: partition, commitSeq, projectionVersion });
	it("orders by commit sequence, beyond the safe-integer range", () => {
		expect(compareCursors(at(9n), at(10n))).toBeLessThan(0);
		expect(compareCursors(at(2n ** 60n + 1n), at(2n ** 60n))).toBeGreaterThan(0);
		expect(compareCursors(at(5n), at(5n))).toBe(0);
	});
	it("refuses to order cursors of other versions or partitions", () => {
		expect(() => compareCursors(at(1n, 1), at(1n, 2))).toThrow();
		expect(() => compareCursors(at(1n), { ...at(1n), partitionId: "6f1d2c3e-0000-4000-8000-000000000002" as ProjectionCursor["partitionId"] })).toThrow();
	});
	it("round-trips through its text form and rejects garbage", () => {
		const cursor = at(2n ** 62n, 3);
		expect(parseCursor(serializeCursor(cursor))).toEqual(cursor);
		expect(() => parseCursor("1:2")).toThrow();
	});
	it("names Pulse subjects per tenant and parses frames", () => {
		expect(pulseSubjects.chat(owner, "c1")).toBe("pim.v2.tenant.o_ada.chat.c1");
		expect(pulseSubjects.sidebar(owner)).toBe("pim.v2.tenant.o_ada.sidebar");
		expect(pulseSubjects.coding(owner, "t1")).toBe("pim.v2.tenant.o_ada.coding.t1");
		expect(ClientFrame.safeParse({ type: "subscribe", topic: "chat" }).success).toBe(true);
		expect(ClientFrame.safeParse({ type: "unsubscribe", topic: "chat" }).success).toBe(true);
		expect(ClientFrame.safeParse({ type: "unsubscribe" }).success).toBe(false);
		expect(ServerFrame.safeParse({ type: "snapshot_required", topic: "chat", reason: "gap" }).success).toBe(true);
		expect(ServerFrame.safeParse({ type: "snapshot_required", topic: "chat", reason: "bored" }).success).toBe(false);
	});
});

describe("migration bands", () => {
	it("keeps bands disjoint and in order", () => {
		const bands = Object.values(MIGRATION_BANDS);
		for (let i = 1; i < bands.length; i++) expect(bands[i]![0]).toBeGreaterThan(bands[i - 1]![1]);
		expect(migrationOwner(1)).toBe("foundation");
		expect(migrationOwner(199)).toBe("runtime");
		expect(migrationOwner(200)).toBe("application");
		expect(migrationOwner(499)).toBe("forge");
		expect(migrationOwner(600)).toBe("integration");
		expect(migrationOwner(799)).toBe("integration");
		expect(migrationOwner(800)).toBeNull();
	});
	it("flags names, band violations and duplicates", () => {
		expect(validateMigrationFiles("runtime", ["0100_a.sql", "0199_b.sql"])).toEqual([]);
		expect(validateMigrationFiles("runtime", ["0200_a.sql"])).toHaveLength(1);
		expect(validateMigrationFiles("runtime", ["0099_a.sql"])).toHaveLength(1);
		expect(validateMigrationFiles("runtime", ["0100_a.sql", "0100_b.sql"])).toHaveLength(1);
		expect(validateMigrationFiles("runtime", ["100_a.sql", "0101_A.sql"])).toHaveLength(2);
		expect(parseMigrationFile("0300_x_y.sql")).toEqual({ number: 300, name: "x_y" });
	});
	it("holds only foundation files in the committed migrations directory, within the band", () => {
		const files = readdirSync(new URL("../migrations", import.meta.url));
		expect(validateMigrationFiles("foundation", files)).toEqual([]);
		const sql = readFileSync(new URL("../migrations/0001_foundation.sql", import.meta.url), "utf8");
		for (const schema of ["pim_app", "pim_runtime", "pim_forge", "pim_projection"]) expect(sql).toContain(`CREATE SCHEMA IF NOT EXISTS ${schema};`);
		expect(sql).toContain("current_setting('pim.owner_id', true)");
	});
});

describe("withTenantTransaction", () => {
	it("sets the owner transaction-locally before the work, inside one transaction", async () => {
		const log: string[] = [];
		const pool: SqlPool = {
			transaction: async (fn) => {
				log.push("BEGIN");
				try {
					return await fn({ query: async (text, values) => (log.push(`${text} ${JSON.stringify(values ?? [])}`), { rows: [] }) });
				} finally {
					log.push("END");
				}
			},
		};
		await withTenantTransaction(pool, "o_ada", async (c) => void (await c.query("SELECT 1")));
		expect(log).toEqual(["BEGIN", `SELECT set_config('pim.owner_id', $1, true) ["o_ada"]`, "SELECT 1 []", "END"]);
	});
	it("refuses an owner id that isn't one before touching the database", async () => {
		const pool: SqlPool = { transaction: () => { throw new Error("opened"); } };
		await expect(withTenantTransaction(pool, "x'; DROP", async () => 1)).rejects.toThrow(/o_|string/i);
	});
});

describe("authorization contracts", () => {
	it("keeps the three refusals distinguishable", () => {
		const errors: AuthzError[] = [new ForbiddenError("coding:push", "no grant"), new CapabilityUnavailableError("coding-pool", "none configured"), new ApprovalRequiredError("coding:merge", "k")];
		expect(errors.map((e) => e.code)).toEqual(["forbidden", "capability_unavailable", "approval_required"]);
		expect(errors[0]).not.toBeInstanceOf(CapabilityUnavailableError);
	});
	it("judges a delegation by its origin, however deep", () => {
		const origin: Principal = { kind: "token", ownerId: owner, role: "member", tokenId: "t", scopes: ["chat"] };
		const chain: Principal = { kind: "delegated", ownerId: owner, delegateId: "a2", originPrincipal: { kind: "delegated", ownerId: owner, delegateId: "a1", originPrincipal: origin } };
		expect(effectivePrincipal(chain)).toBe(origin);
	});
	it("matches repositories by exact name or owner wildcard only", () => {
		expect(repositoryAllowed(["github.com/org/*"], "github.com/org/repo")).toBe(true);
		expect(repositoryAllowed(["github.com/org/*"], "github.com/organ/repo")).toBe(false);
		expect(repositoryAllowed(["github.com/org/repo"], "github.com/org/repo2")).toBe(false);
		expect(repositoryAllowed([], "github.com/org/repo")).toBe(false);
	});
	it("matches the same repository however it is spelled, on either side", () => {
		for (const entry of ["ajac-zero/*", "github.com/ajac-zero/*", "AJAC-zero/pim", "*"]) {
			for (const repo of ["ajac-zero/pim", "github.com/ajac-zero/pim", "https://github.com/ajac-zero/pim.git", "https://github.com/ajac-zero/pim/"]) expect(repositoryAllowed([entry], repo), `${entry} ~ ${repo}`).toBe(true);
		}
		// A host in the entry pins the host; a repository with no host is on GitHub; an entry with no host covers any.
		expect(repositoryAllowed(["github.com/ajac-zero/*"], "git.example.com/ajac-zero/pim")).toBe(false);
		expect(repositoryAllowed(["git.example.com/ajac-zero/*"], "ajac-zero/pim")).toBe(false);
		expect(repositoryAllowed(["ajac-zero/*"], "https://git.example.com/ajac-zero/pim")).toBe(true);
		expect(repositoryAllowed(["ajac-zero/*"], "ajac-zero-evil/pim")).toBe(false);
		expect(repositoryAllowed(["*"], "not a repo")).toBe(false);
		expect(normalizeRepository("https://GitHub.com/Ajac-Zero/Pim.git")).toBe("github.com/ajac-zero/pim");
		expect(normalizeRepository("ajac-zero/*")).toBe("ajac-zero/*");
		expect(normalizeRepository("nonsense")).toBeNull();
	});
	it("applies a standing approval only inside its scope, unrevoked and unexpired", () => {
		const base: StandingApproval = { approvalId: "s1", ownerId: owner, action: "coding:merge", scope: { repository: "github.com/org/repo" }, grantedBy: owner, grantedAt: "2026-01-01T00:00:00Z" };
		const now = new Date("2026-06-01T00:00:00Z");
		const resource = { repository: "github.com/org/repo", branch: "main" };
		expect(standingApprovalCovers(base, "coding:merge", resource, now)).toBe(true);
		expect(standingApprovalCovers(base, "coding:push", resource, now)).toBe(false);
		expect(standingApprovalCovers(base, "coding:merge", { repository: "github.com/org/other" }, now)).toBe(false);
		expect(standingApprovalCovers({ ...base, expiresAt: "2026-05-31T23:59:59Z" }, "coding:merge", resource, now)).toBe(false);
		expect(standingApprovalCovers({ ...base, revokedAt: "2026-02-01T00:00:00Z" }, "coding:merge", resource, now)).toBe(false);
	});
});

describe("process configuration", () => {
	const env = { PIM_PUBLIC_URL: "https://pim.example.com", PIM_DATABASE_URL: "postgres://x", PIM_NATS_URL: "nats://x", PIM_S3_ENDPOINT: "http://s3.example.com", PIM_S3_BUCKET: "b" };
	it("loads defaults and overrides a pool budget", () => {
		const config = loadProcessConfig({ ...env, PIM_POOL_TOOLS_MAX: "3" });
		expect(config.role).toBe("all-in-one");
		expect(config.pools.tools.max).toBe(3);
		expect(config.pools.foreground.max).toBe(20);
	});
	it("names every bad variable and rejects an unknown role", () => {
		expect(() => loadProcessConfig({ PIM_ROLE: "durable-object" })).toThrow(/PIM_ROLE.*PIM_PUBLIC_URL|PIM_PUBLIC_URL.*PIM_ROLE/);
		expect(rolesOf("all-in-one")).toContain("runner");
		expect(rolesOf("all-in-one")).not.toContain("all-in-one");
		expect(rolesOf("gate")).toEqual(["gate"]);
	});
});
