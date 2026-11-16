import net from "node:net";

/**
 * A TCP proxy in front of PostgreSQL that can break the connection around one COMMIT of a pi commit (the transaction
 * that writes commit_receipts): after forwarding it, so the commit lands but its acknowledgement never arrives, or
 * instead of forwarding it, so the commit never lands. Everything else passes through untouched.
 */
export class FaultProxy {
	readonly #server: net.Server;
	readonly #sockets = new Set<net.Socket>();
	#mode: "none" | "lose-ack" | "drop-before" = "none";
	port = 0;
	fired = 0;

	constructor(private readonly target: { host: string; port: number }) {
		this.#server = net.createServer((client) => this.#accept(client));
	}

	async listen(): Promise<void> {
		await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
		this.port = (this.#server.address() as net.AddressInfo).port;
	}

	/** Break the next pi commit's COMMIT: `lose-ack` forwards it first, `drop-before` does not. */
	arm(mode: "lose-ack" | "drop-before"): void {
		this.#mode = mode;
	}

	#accept(client: net.Socket): void {
		const upstream = net.connect(this.target.port, this.target.host);
		this.#sockets.add(client).add(upstream);
		let sawReceipt = false;
		const closeBoth = (): void => {
			client.destroy();
			upstream.destroy();
		};
		client.on("data", (chunk) => {
			const text = chunk.toString("latin1");
			if (text.includes("commit_receipts")) sawReceipt = true;
			if (sawReceipt && this.#mode !== "none" && /^Q.{4}COMMIT\0/s.test(text)) {
				const mode = this.#mode;
				this.#mode = "none";
				this.fired++;
				if (mode === "lose-ack") {
					upstream.write(chunk, () => setTimeout(closeBoth, 30));
					// The answer is never relayed: stop reading it.
					upstream.removeAllListeners("data");
				} else {
					closeBoth();
				}
				return;
			}
			// The transaction that wrote a receipt ends here; the next one on this connection is not the pi commit.
			if (/^Q.{4}(COMMIT|ROLLBACK)\0/s.test(text)) sawReceipt = false;
			upstream.write(chunk);
		});
		upstream.on("data", (chunk) => client.write(chunk));
		client.on("error", closeBoth);
		upstream.on("error", closeBoth);
		client.on("close", closeBoth);
		upstream.on("close", closeBoth);
	}

	async close(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		await new Promise<void>((resolve) => this.#server.close(() => resolve()));
	}
}
