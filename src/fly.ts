import type { FlyComputers } from "./deployment";
import { HttpError } from "./http";

/**
 * Computers Pim starts for people who don't bring one: a Fly.io Machine
 * each, running computer/Dockerfile's image, which runs pim-computer as any
 * other computer does. Its whole disk persists, so what agents and the
 * person install there stays, as on a computer of their own. Pim suspends
 * it when it goes unused, which keeps its memory, and starts it again when
 * it's needed (see ./computer.ts).
 */

const API = "https://api.machines.dev/v1";

export class FlyMachines {
	readonly #settings: FlyComputers;
	readonly #token: string;

	constructor(settings: FlyComputers, token: string) {
		this.#settings = settings;
		this.#token = token;
	}

	async #call<T>(method: string, path: string, body?: unknown, gone?: T): Promise<T> {
		const response = await fetch(`${API}/apps/${this.#settings.app}/machines${path}`, {
			method,
			headers: { Authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (response.status === 404 && gone !== undefined) return gone;
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 300);
			console.error(JSON.stringify({ event: "fly.failed", method, path, status: response.status, detail }));
			throw new HttpError(502, `Fly.io couldn't ${method === "DELETE" ? "remove" : "start or stop"} the computer (${response.status}). Try again later.`);
		}
		return (response.status === 204 ? null : await response.json()) as T;
	}

	/** Creates and starts a machine named `name` that runs pim-computer with `env`; its ID. */
	async create(name: string, env: Record<string, string>): Promise<string> {
		const { image, region, memoryMb, diskGb } = this.#settings;
		const machine = await this.#call<{ id: string }>("POST", "", {
			name,
			...(region ? { region } : {}),
			config: {
				image,
				env,
				guest: { cpu_kind: "shared", cpus: 2, memory_mb: memoryMb },
				rootfs: { persist: "always", size_gb: diskGb },
				restart: { policy: "always" },
				auto_destroy: false,
				metadata: { pim: "computer" },
			},
		});
		return machine.id;
	}

	/** Starts the machine, from where it was suspended if it can. */
	async start(id: string): Promise<void> {
		await this.#call("POST", `/${id}/start`);
	}

	/**
	 * Suspends the machine, memory and all, until it's started again, and
	 * waits until it has: its connection is let go only once it can't
	 * connect again.
	 */
	async suspend(id: string): Promise<void> {
		await this.#call("POST", `/${id}/suspend`);
		await this.#call("GET", `/${id}/wait?state=suspended&timeout=60`);
	}

	/** Removes the machine, with everything on it; one that's gone already is removed. */
	async destroy(id: string): Promise<void> {
		await this.#call("DELETE", `/${id}?force=true`, undefined, null);
	}
}
