// A test's stand-in for a managed launcher: supervises one tiny Node job under a handle, writing its intent and receipt in the given state folder.
import { superviseManaged } from "../../computer/triggers-adapters/managed.ts";

const jobs: Record<string, string> = {
	exit0: "process.exit(0)",
	exit2: "process.exit(2)",
	signalled: "process.kill(process.pid, 'SIGTERM')",
	wait: "setTimeout(() => {}, 1500)",
};
const [stateDir, handle, job] = process.argv.slice(2);
const code = job === undefined ? undefined : jobs[job];
if (!stateDir || !handle || !code) throw new Error("usage: managed-wrapper <stateDir> <handle> <job>");
await superviseManaged({ stateDir, handle, file: process.execPath, args: ["-e", code] });
