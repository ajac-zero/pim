import { createHash } from "node:crypto";
import type { Pool } from "pg";

/** The same UUID PostgreSQL makes from md5(text)::uuid, so JavaScript and SQL name a partition alike. */
export const md5Uuid = (text: string) => {
	const h = createHash("md5").update(text).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** What the bench adds beside the landing schema: leases with an epoch for fencing, and the coding transcript table floods write to. */
export const BENCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_ops.bench_leases (
	partition_id uuid PRIMARY KEY,
	owner text NOT NULL,
	epoch bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS pim_ops.bench_coding_events (
	thread_id text NOT NULL,
	seq bigint NOT NULL,
	kind text NOT NULL,
	body jsonb NOT NULL,
	PRIMARY KEY (thread_id, seq)
);
`;

export type Seeded = { readonly runs: { tenant: string; conversation: number; partition: string; chat: string }[]; readonly tenants: string[]; readonly idleChats: number; readonly idleEntries: number };

/**
 * Creates tenants, one partition and conversation per active run, and the idle chats with history, all in SQL so that seeding 100 tenants with 20,000 idle chats
 * takes seconds. Ids come from one per-tenant sequence, as in the landing schema.
 */
export async function seed(pool: Pool, options: { tenants: number; activeRuns: number; idleChatsPerTenant: number; entriesPerIdleChat: number }): Promise<Seeded> {
	await pool.query(BENCH_SCHEMA);
	const tenants = Array.from({ length: options.tenants }, (_, i) => `o_bt${String(i).padStart(3, "0")}`);
	await pool.query("INSERT INTO pim_ops.tenants (owner_id, username, role, status, created_at_ms) SELECT t, t, 'member', 'active', 0 FROM unnest($1::text[]) t ON CONFLICT DO NOTHING", [tenants]);
	await pool.query("INSERT INTO pim_ops.owner_id_sequence (owner_id, next_id) SELECT t, 1000000 FROM unnest($1::text[]) t ON CONFLICT DO NOTHING", [tenants]);
	await pool.query("INSERT INTO pim_ops.partitions (owner_id, partition_id, home, next_commit_seq) SELECT t, md5(t || ':home')::uuid, true, 1 FROM unnest($1::text[]) t ON CONFLICT DO NOTHING", [tenants]);
	// Idle conversations: ids 2.. per tenant, each in its own partition and family, with `entriesPerIdleChat` entries.
	await pool.query(
		`WITH c AS (SELECT t.t AS tenant, g AS n FROM unnest($1::text[]) t(t), generate_series(1, $2::int) g)
		 INSERT INTO pim_ops.partitions (owner_id, partition_id, home, next_commit_seq) SELECT tenant, md5(tenant || ':idle-' || n)::uuid, false, $3::int + 1 FROM c ON CONFLICT DO NOTHING`,
		[tenants, options.idleChatsPerTenant, options.entriesPerIdleChat],
	);
	await pool.query(
		`INSERT INTO pim_ops.pi_conversations (owner_id, id, partition_id, record) SELECT t.t, 10 + g, md5(t.t || ':idle-' || g)::uuid, jsonb_build_object('id', 10 + g) FROM unnest($1::text[]) t(t), generate_series(1, $2::int) g ON CONFLICT DO NOTHING`,
		[tenants, options.idleChatsPerTenant],
	);
	await pool.query(
		`INSERT INTO pim_ops.chats (owner_id, public_id, conversation_id, title, created_at_ms, updated_at_ms) SELECT t.t, 'idle-' || g || '-' || t.t, 10 + g, 'Idle chat ' || g, 0, g FROM unnest($1::text[]) t(t), generate_series(1, $2::int) g ON CONFLICT DO NOTHING`,
		[tenants, options.idleChatsPerTenant],
	);
	await pool.query(
		`INSERT INTO pim_ops.pi_entries (owner_id, id, partition_id, conversation_id, commit_seq, record)
		 SELECT t.t, 100000 + g * 100 + e, md5(t.t || ':idle-' || g)::uuid, 10 + g, e, jsonb_build_object('id', 100000 + g * 100 + e, 'kind', 'message', 'model', jsonb_build_array(jsonb_build_object('role', CASE WHEN e % 2 = 0 THEN 'assistant' ELSE 'user' END, 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', repeat('lorem ipsum ', 20))))))
		 FROM unnest($1::text[]) t(t), generate_series(1, $2::int) g, generate_series(1, $3::int) e ON CONFLICT DO NOTHING`,
		[tenants, options.idleChatsPerTenant, options.entriesPerIdleChat],
	);
	// Active runs: round-robin over tenants; each run has its own family partition and conversation, with a 30-entry history.
	const runs: Seeded["runs"] = [];
	for (let i = 0; i < options.activeRuns; i++) {
		const tenant = tenants[i % tenants.length]!;
		const n = Math.floor(i / tenants.length);
		runs.push({ tenant, conversation: 500_000 + n, partition: md5Uuid(`${tenant}:run-${n}`), chat: `run-${n}-${tenant}` });
	}
	await pool.query("INSERT INTO pim_ops.partitions (owner_id, partition_id, home, next_commit_seq) SELECT t, p, false, 31 FROM unnest($1::text[], $2::uuid[]) x(t, p) ON CONFLICT DO NOTHING", [runs.map((r) => r.tenant), runs.map((r) => r.partition)]);
	await pool.query("INSERT INTO pim_ops.pi_conversations (owner_id, id, partition_id, record) SELECT t, c, p, jsonb_build_object('id', c) FROM unnest($1::text[], $2::bigint[], $3::uuid[]) x(t, c, p) ON CONFLICT DO NOTHING", [runs.map((r) => r.tenant), runs.map((r) => r.conversation), runs.map((r) => r.partition)]);
	await pool.query("INSERT INTO pim_ops.chats (owner_id, public_id, conversation_id, title, created_at_ms, updated_at_ms) SELECT t, h, c, 'Active run', 0, 0 FROM unnest($1::text[], $2::text[], $3::bigint[]) x(t, h, c) ON CONFLICT DO NOTHING", [runs.map((r) => r.tenant), runs.map((r) => r.chat), runs.map((r) => r.conversation)]);
	await pool.query(
		`INSERT INTO pim_ops.pi_entries (owner_id, id, partition_id, conversation_id, commit_seq, record)
		 SELECT x.t, x.c * 100 + e, x.p, x.c, e, jsonb_build_object('id', x.c * 100 + e, 'kind', 'message', 'model', jsonb_build_array(jsonb_build_object('role', 'user', 'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', repeat('history ', 30))))))
		 FROM unnest($1::text[], $2::bigint[], $3::uuid[]) x(t, c, p), generate_series(1, 30) e ON CONFLICT DO NOTHING`,
		[runs.map((r) => r.tenant), runs.map((r) => r.conversation), runs.map((r) => r.partition)],
	);
	await pool.query("ANALYZE");
	return { runs, tenants, idleChats: options.idleChatsPerTenant * options.tenants, idleEntries: options.idleChatsPerTenant * options.tenants * options.entriesPerIdleChat };
}
