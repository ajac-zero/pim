import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function findBinDir(): string | undefined {
	const root = "/usr/lib/postgresql";
	if (!existsSync(root)) return undefined;
	const versions = readdirSync(root).sort((a, b) => Number(b) - Number(a));
	for (const version of versions) if (existsSync(join(root, version, "bin", "initdb"))) return join(root, version, "bin");
	return undefined;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

/**
 * Gives the tests a PostgreSQL: the server named by PIM_V2_PG_URL, or a throwaway cluster started here on a free port
 * from the installed binaries (scripts/ensure-postgres.sh installs them). fsync is off: the tests check logic, not disks.
 */
export default async function setup(): Promise<() => void> {
	if (process.env.PIM_V2_PG_URL) return () => {};
	const bin = findBinDir();
	if (bin === undefined) throw new Error("No PostgreSQL found. Run packages/v2-runtime/scripts/ensure-postgres.sh, or set PIM_V2_PG_URL.");
	const dir = mkdtempSync(join(tmpdir(), "pim-v2-pg-"));
	const port = await freePort();
	execFileSync(join(bin, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], { stdio: "ignore" });
	const started = spawnSync(
		join(bin, "pg_ctl"),
		["-D", join(dir, "data"), "-w", "-l", join(dir, "log"), "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=300 -c unix_socket_directories=${dir}`, "start"],
		{ encoding: "utf8" },
	);
	if (started.status !== 0) throw new Error(`pg_ctl start failed: ${started.stdout}${started.stderr}`);
	process.env.PIM_V2_PG_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
	return () => {
		spawnSync(join(bin, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
		rmSync(dir, { recursive: true, force: true });
	};
}
