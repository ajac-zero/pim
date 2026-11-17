// One process of the integrated benchmark's deployment, started as `node --import tsx integrated-process.ts <gate|live|runner|probe>` with its configuration in the environment, as the
// deployment's containers are. gate, live and runner are the product's own roles (`startProcess` of @pim/v2-server); the Runner's models are one controlled streaming provider (pi-ai's faux
// provider): a reply is a fixed length written at a fixed token rate, so what a conversation costs grows with its history and nothing else. `probe` is the foreground load: closed-loop readers
// of one person's `/api/sessions` and `/api/snapshot/sidebar`, in a process of their own so the generator's event loop is not part of what they measure. Each reports `{ ready, port, metricsPort }` over IPC.
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, type HarnessOptions } from "@earendil-works/pi-durable";
import { startProcess } from "../../packages/v2-server/src/main.ts";

const role = process.argv[2]!;
const env = process.env as Record<string, string>;
const send = (message: unknown) => process.send?.(message);

/** A reply of `chars` characters, so that every turn streams for the same time whatever the history before it. */
const reply = (chars: number) => "Here is a streamed answer written token by token, as a model writes one. ".repeat(Math.ceil(chars / 70)).slice(0, chars);

async function pim() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }], tokensPerSecond: Number(env.BENCH_TOKENS_PER_SECOND ?? 25), tokenSize: { min: 2, max: 3 } });
	// A reply is taken from the queue by the call that streams it, and puts one back: the queue never runs dry however long the run.
	const next = (): ReturnType<typeof fauxAssistantMessage> => (faux.appendResponses([next]), fauxAssistantMessage(reply(Number(env.BENCH_REPLY_CHARS ?? 240))));
	faux.setResponses(Array.from({ length: 256 }, () => next));
	const models = createModels();
	models.setProvider(faux.provider);
	const agent = { model: { provider: "faux", modelId: "m" } };
	const hooks = { harnessOptions: (): HarnessOptions => ({ models, registry: createRegistry(), settings: { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1_000 } } as never }), homeRoot: () => ({ agent }), chatAgent: () => agent, ...(env.BENCH_POLL_MS ? { pollMs: Number(env.BENCH_POLL_MS) } : {}) };
	const proc = await startProcess(role, env, hooks);
	send({ ready: true, port: proc.host.port, metricsPort: proc.host.metricsPort });
	process.on("message", (m: { type?: string }) => {
		if (m.type === "stop") void proc.close().finally(() => process.exit(0));
	});
}

/** Closed-loop reads of one person's pages for as long as a `start` lasts; `stop` returns the samples of that window. */
async function probe() {
	const { token, gate, ingress, readers = 4, thinkMs = 40 } = JSON.parse(env.BENCH_PROBE!) as { token: string; gate: string; ingress: string; readers?: number; thinkMs?: number };
	let running = false;
	let loops: Promise<void>[] = [];
	let samples: { path: string; ms: number; status: number }[] = [];
	const read = async (path: string) => {
		const t0 = performance.now();
		const res = await fetch(gate + path, { headers: { authorization: `Bearer ${token}`, "x-pim-ingress-secret": ingress } }).catch(() => undefined);
		await res?.arrayBuffer();
		samples.push({ path, ms: performance.now() - t0, status: res?.status ?? 0 });
	};
	process.on("message", async (m: { type?: string }) => {
		if (m.type === "start") {
			samples = [];
			running = true;
			loops = Array.from({ length: readers }, (_, k) =>
				(async () => {
					while (running) {
						await read(k % 2 ? "/api/sessions" : "/api/snapshot/sidebar");
						await new Promise((r) => setTimeout(r, thinkMs));
					}
				})(),
			);
		} else if (m.type === "stop") {
			running = false;
			await Promise.all(loops);
			send({ samples });
		} else if (m.type === "exit") process.exit(0);
	});
	send({ ready: true });
}

await (role === "probe" ? probe() : pim());
