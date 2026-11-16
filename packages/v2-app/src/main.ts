import { loadProcessConfig, rolesOf } from "@pim/v2-contracts/platform";
import { App } from "./app.ts";
import { connect } from "./db.ts";
import { createGate } from "./gate.ts";
import { S3ObjectStore } from "./objects.ts";

/**
 * Starts the Gate from the process configuration (`PIM_*` variables, see `loadProcessConfig`). The database login is `pim_gate`; the S3 credentials
 * are the standard AWS ones. Only the `gate` and `all-in-one` roles run it; the other roles belong to other packages.
 */
export async function startGate(env: Record<string, string | undefined> = process.env, port = Number(env.PORT ?? 8787)) {
	const config = loadProcessConfig(env);
	if (!rolesOf(config.role).includes("gate")) throw new Error(`PIM_ROLE=${config.role} does not run the Gate`);
	const db = connect(config.databaseUrl, config.pools.foreground.max, config.pools.foreground.statementTimeoutMs);
	const app = new App(db, new S3ObjectStore(config.s3.bucket, { endpoint: config.s3.endpoint, region: config.s3.region }));
	const server = createGate(app);
	await new Promise<void>((resolve) => server.listen(port, resolve));
	return { server, app, close: () => new Promise<void>((resolve) => server.close(() => db.end().then(resolve))) };
}
