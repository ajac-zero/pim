// Gives every tab of a Chrome started with --remote-debugging-port a virtual passkey
// authenticator, so the local preview's passkey screens work on a machine without one (a
// headless browser, a Linux desktop). It answers every passkey prompt itself, at once.
// Development only: `node scripts/virtual-authenticator.mjs [port]`, and keep it running.

const port = Number(process.argv[2] ?? 9222);
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const socket = new WebSocket(webSocketDebuggerUrl);
let nextId = 0;
const waiting = new Map();

function send(method, params = {}, sessionId) {
	const id = ++nextId;
	socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
}

async function equip(targetId) {
	try {
		const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
		await send("WebAuthn.enable", { enableUI: false }, sessionId);
		await send(
			"WebAuthn.addVirtualAuthenticator",
			{
				options: {
					protocol: "ctap2",
					transport: "internal",
					hasResidentKey: true,
					hasUserVerification: true,
					isUserVerified: true,
					automaticPresenceSimulation: true,
				},
			},
			sessionId,
		);
		console.log(`virtual authenticator added to tab ${targetId}`);
	} catch (error) {
		// A tab equipped by an earlier run keeps its authenticator, and its passkeys.
		if (/only supports one internal authenticator/.test(error.message)) console.log(`tab ${targetId} already has one`);
		else console.error(`tab ${targetId}: ${error.message}`);
	}
}

socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id && waiting.has(message.id)) {
		const { resolve, reject } = waiting.get(message.id);
		waiting.delete(message.id);
		if (message.error) reject(new Error(message.error.message));
		else resolve(message.result);
		return;
	}
	if (message.method === "Target.targetCreated" && message.params.targetInfo.type === "page") {
		void equip(message.params.targetInfo.targetId);
	}
});

await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
await send("Target.setDiscoverTargets", { discover: true });
const { targetInfos } = await send("Target.getTargets");
for (const target of targetInfos.filter((info) => info.type === "page")) await equip(target.targetId);
console.log(`Watching Chrome on port ${port} for new tabs. Ctrl-C to stop.`);
