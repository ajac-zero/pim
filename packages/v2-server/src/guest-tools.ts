/**
 * What a guest's agent can do in someone else's space: the tools of the host's connectors that the host granted the guest's audience (a bot's link, or a circle),
 * and nothing else. `guest_tools` lists them; `guest_call` calls one, re-reading the boundary first (`Guests.boundary`: the bot still shared, the circle enabled
 * and the member still in it), counting the call against the guest's day, and, for a tool the host wants to approve each time, filing an approval on the host and
 * parking until the host decides (the Gate carries the decision back to this task, in the guest's own chat). The host's credential is opened here with the
 * deployment's keys and used for this one call; it never reaches the guest's agent, and the guest's agent never sees a connector the host did not grant.
 */
import { Type } from "typebox";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import type { Boundary, GuestConnector } from "@pim/v2-app/guests";
import { toolDefinition } from "@pim/v2-app/tool-permissions";
import { sniffImage } from "@pim/v2-app/objects";
import { OwnerId, PartitionId, type Principal } from "@pim/v2-contracts/identity";
import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import type { ExternalOperations } from "@pim/v2-runtime/external";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { CredentialRenewals, runtimeStore } from "./connector-credential.ts";
import { type ImageSources, IMAGE_EXTENSIONS, pickImageModel } from "./image-tools.ts";
import { listTools, McpAuthError, type McpTool, resultText, type Transport, withSession } from "./connector-tools.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

export type GuestToolsDeps = {
	ownerId: string;
	partitionId: string;
	runtime: RuntimeDb;
	app: App | undefined;
	crypto: EnvelopeCrypto | undefined;
	transport: Transport;
	ops: ExternalOperations;
	owner: unknown;
	now: () => number;
	chatOf(conversationId: number | string): Promise<string | null>;
	/** Where a host's images are drawn (`./image-tools.ts`); a bot can share `generate_image` with its guests, which the host's own image model draws. Absent, none can. */
	imagesOf?: ((ownerId: string) => ImageSources | undefined) | undefined;
	fetch?: typeof fetch;
};

/**
 * `generate_image` is the one tool a bot shares that no connector provides: the host's image model draws it (the host pays), the picture is kept in the host's files, in a
 * folder of the guest's under `/workspace/bots/<bot>/`, and a copy in the guest's own files is what their chat shows. It is offered as a connector of its own, `pim`.
 */
export const IMAGES_CONNECTOR = "pim";
const GENERATE_IMAGE = "generate_image";
const IMAGE_CONNECTOR: GuestConnector = { id: IMAGES_CONNECTOR, kind: "pim", name: "Pim", url: "", status: "connected", credential: null, enabledTools: [GENERATE_IMAGE] };
const IMAGE_TOOL: McpTool = {
	name: GENERATE_IMAGE,
	description: "Make an image from a description; the chat shows it to the person as soon as it's made, so don't link or describe it again. Describe what to draw in detail, in English: the subject, the setting, the style, composition, lighting and colors, and any words it should show, in quotes. Make one image unless they ask for more: each one costs.",
	inputSchema: { type: "object", properties: { prompt: { type: "string", minLength: 1, maxLength: 2000, description: "What to draw, in detail." }, shape: { enum: ["square", "landscape", "portrait"], description: "The image's shape; square by default." } }, required: ["prompt"] },
};

const redact = (value: unknown) => JSON.parse(JSON.stringify(value ?? {}), (k, v) => (/token|secret|password|authorization|api[_-]?key/i.test(k) ? "[redacted]" : v));
const LISTED_FOR_MS = 30_000;

export function guestToolset(deps: GuestToolsDeps): ToolRegistration[] {
	const { ownerId, runtime } = deps;
	const listed = new Map<string, { at: number; tools: Promise<McpTool[]> }>();
	const noApp = () => text("This Runner has no application database (PIM_APP_DATABASE_URL), so it cannot reach anyone's space.", true);

	const renewals = new CredentialRenewals({ crypto: deps.crypto, store: runtimeStore(runtime), fetch: deps.transport.fetch, now: deps.now });
	async function withBearer<T>(b: Boundary, c: GuestConnector, run: (bearer: string | null) => Promise<T>): Promise<T> {
		const first = await renewals.open(b.host, { id: c.id, name: c.name, url: c.url, credential: c.credential });
		try {
			return await run(first.bearer);
		} catch (error) {
			if (!(error instanceof McpAuthError)) throw error;
			return run((await renewals.open(b.host, { id: c.id, name: c.name, url: c.url, credential: first.sealed }, true)).bearer);
		}
	}
	const toolsOf = (b: Boundary, c: GuestConnector): Promise<McpTool[]> => {
		const key = `${b.host}\u0000${c.id}\u0000${c.url}`;
		const held = listed.get(key);
		if (held && deps.now() - held.at < LISTED_FOR_MS) return held.tools;
		const tools = withBearer(b, c, (bearer) => listTools(deps.transport, c.url, bearer));
		listed.set(key, { at: deps.now(), tools });
		tools.catch(() => listed.delete(key));
		return tools;
	};
	/** Draws one image for the guest on the host's image model, keeps it in the host's files and gives the guest's chat its own copy; the answer is a connector tool's. */
	async function drawForGuest(app: App, b: Boundary, sources: ImageSources, a: Record<string, unknown>, context: { abortSignal?: AbortSignal } | undefined) {
		const fail = (message: string) => ({ isError: true, content: [{ type: "text", text: message }] });
		if (typeof a.prompt !== "string" || a.prompt === "" || a.prompt.length > 2000) return fail("prompt is required, up to 2000 characters.");
		const who = await pickImageModel(sources, deps.fetch ?? fetch);
		if (!who) return fail("Images can't be made right now.");
		try {
			const shape = a.shape === "landscape" || a.shape === "portrait" ? a.shape : "square";
			const bytes = await who.draw(a.prompt, shape, context?.abortSignal);
			const type = sniffImage(bytes);
			if (!type || bytes.length > 25_000_000) throw new Error("The image model answered with something that isn't an image.");
			const name = `${new Date(deps.now()).toISOString().replace(/[:.]/g, "-")}.${IMAGE_EXTENSIONS[type]}`;
			const agent = (ownerId: string): Principal => ({ kind: "agent", ownerId: OwnerId.parse(ownerId), agentId: "pim" });
			const kept = `/workspace/bots/${b.botId}/${b.guest}/${name}`;
			const shown = `/workspace/images/${name}`;
			await app.objects.put(agent(b.host), { bytes, contentType: type, purpose: "file", key: `${b.host}/files${kept}` });
			await app.objects.put(agent(b.guest), { bytes, contentType: type, purpose: "file", key: `${b.guest}/files${shown}` });
			await runtime.read(b.host, "SELECT pim_app.record_model_call($1, $2, 'chat', NULL, $3, $4, 0, 0, 0)", [b.host, `mc_img_guest_${b.guest}_${name}`.slice(0, 120), "images", who.id]).catch(() => undefined);
			return { content: [{ type: "text", text: JSON.stringify({ image: { path: shown, model: who.id, type, bytes: bytes.length }, note: "The person sees it in the chat now." }) }] };
		} catch (error) {
			return fail(`The image wasn't made: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const refused = async (app: App, b: Boundary | null, tool: string, message: string): Promise<Result> => {
		if (b) await app.guests.log(b, tool, "refused", message).catch(() => undefined);
		return text(message, true);
	};

	const list = defineTool({
		name: "guest_tools",
		description: "The tools of the host's connected services that the host lets you use, with what each takes. A tool marked asksFirst waits for the host's approval when you call it. Call one with guest_call.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute(_args: unknown, api: any) {
			const app = deps.app;
			if (!app) return noApp();
			try {
				const b = await app.guests.boundary(ownerId, await deps.chatOf(api.conversationId));
				const { connectors, permissions } = await app.guests.hostConnectors(b);
				const out: unknown[] = [];
				for (const c of connectors) {
					for (const t of await toolsOf(b, c).catch(() => [] as McpTool[])) {
						const permission = app.guests.permissionOf(b, c, { name: t.name, destructive: t.annotations?.destructiveHint === true, definition: toolDefinition(t) }, permissions);
						if (permission !== "off") out.push({ connector: c.id, service: c.name, tool: t.name, description: t.description ?? null, inputSchema: t.inputSchema, asksFirst: permission === "ask" });
					}
				}
				if (b.kind === "bot" && b.tools.includes(GENERATE_IMAGE) && deps.imagesOf?.(b.host)) {
					const permission = app.guests.permissionOf(b, IMAGE_CONNECTOR, { name: GENERATE_IMAGE }, permissions);
					if (permission !== "off") out.push({ connector: IMAGES_CONNECTOR, service: IMAGE_CONNECTOR.name, tool: GENERATE_IMAGE, description: IMAGE_TOOL.description, inputSchema: IMAGE_TOOL.inputSchema, asksFirst: permission === "ask" });
				}
				return text(out.length ? JSON.stringify({ host: b.hostName, tools: out }, null, 1) : `${b.hostName} hasn't shared any tools with you.`);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	} as never) as unknown as ToolRegistration;

	const call = defineTool({
		name: "guest_call",
		description: "Call a tool the host shares with you (see guest_tools). Arguments are the tool's own. A tool the host wants to approve first waits for their answer, and a call with effects is sent once.",
		parameters: Type.Object({ connector: Type.String({ minLength: 1 }), tool: Type.String({ minLength: 1 }), arguments: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
		// Safe to replay: a parked call finds its approval again (the id is a digest of the call), and a call with effects is made once through its operation.
		replay: "safe",
		async execute(args: { connector: string; tool: string; arguments?: Record<string, unknown> }, api: any, context?: any) {
			const app = deps.app;
			if (!app) return noApp();
			let b: Boundary | null = null;
			try {
				const chat = await deps.chatOf(api.conversationId);
				b = await app.guests.boundary(ownerId, chat);
				const { connectors, permissions } = await app.guests.hostConnectors(b);
				const images = args.connector === IMAGES_CONNECTOR && args.tool === GENERATE_IMAGE && b.kind === "bot" && b.tools.includes(GENERATE_IMAGE) ? deps.imagesOf?.(b.host) : undefined;
				const c = images ? IMAGE_CONNECTOR : connectors.find((x) => x.id === args.connector);
				const tool = images ? IMAGE_TOOL : c ? (await toolsOf(b, c)).find((t) => t.name === args.tool) : undefined;
				// A tool the host did not grant is answered as one that does not exist: nothing says what else the host has connected.
				if (!c || !tool) return await refused(app, b, args.tool, `${b.hostName} doesn't share a tool ${args.tool} with you.`);
				const readOnly = tool.annotations?.readOnlyHint === true;
				const permission = app.guests.permissionOf(b, c, { name: tool.name, destructive: tool.annotations?.destructiveHint === true, definition: toolDefinition(tool) }, permissions);
				if (permission === "off") return await refused(app, b, tool.name, `${b.hostName} doesn't share a tool ${args.tool} with you.`);
				const taskId = String(api.taskId);
				if (permission === "ask") {
					const signal = (await runtime.read<{ payload: { approved?: boolean } }>(ownerId, "SELECT payload FROM pim_runtime.durable_signals WHERE owner_id = $1 AND task_id = $2 AND kind = 'approval' ORDER BY signal_id DESC LIMIT 1", [ownerId, taskId])).rows[0];
					if (signal && signal.payload.approved !== true) return await refused(app, b, tool.name, `${b.hostName} didn't approve that call, so it was not made.`);
					if (!signal) {
						if (!(await app.guests.countCall(b))) return await refused(app, b, tool.name, `You have used the calls ${b.hostName} allows a day. They reset at midnight UTC.`);
						const filed = await app.guests.file(b, { chat: chat ?? "", taskId, callId: String(api.callId), connector: c.id, service: c.name, tool: tool.name, arguments: redact(args.arguments), resource: { connector: c.id, tool: tool.name } });
						if (filed.state === "timed_out_denied") return await refused(app, b, tool.name, `${b.hostName} didn't answer within a day, so the call was not made.`);
						await app.guests.log(b, tool.name, "asked", `Asked ${b.hostName} to approve ${tool.name} of ${c.name}`);
						return { output: [{ type: "text", text: `Waiting for ${b.hostName} to approve.` }], control: { suspend: true } } as never;
					}
				} else if (!(await app.guests.countCall(b))) {
					return await refused(app, b, tool.name, `You have used the calls ${b.hostName} allows a day. They reset at midnight UTC.`);
				}
				const run = images ? () => drawForGuest(app, b!, images, args.arguments ?? {}, context) : () => withBearer(b!, c, (bearer) => withSession(deps.transport, c.url, bearer, (rpc) => rpc("tools/call", { name: tool.name, arguments: args.arguments ?? {} }), 30_000));
				if (readOnly) {
					const result = await run();
					await app.guests.log(b, tool.name, "ran", `Used ${tool.name} of ${c.name}`);
					return text(resultText(result), result?.isError === true);
				}
				const operationId = `guest:${deps.partitionId}:${taskId}:${api.callId}`;
				const op = await deps.ops.begin({ operationId, ownerId: deps.owner, partitionId: PartitionId.parse(deps.partitionId), taskId, toolName: "guest_call", capability: `guest:${b.host}:${c.id}`, idempotencyKey: `pim-guest-${ownerId}-${deps.partitionId}-${taskId}-${api.callId}` } as never);
				if (op.state === "completed") return text(String((op.receipt as any)?.summary ?? "Done."));
				if (op.state === "failed" || op.state === "cancelled") return text(`The call did not go through: ${String((op.receipt as any)?.error ?? op.state)}`, true);
				if (op.state !== "pending") return text(`The call was started, but what became of it is not known (${op.state}). It was not made again.`, true);
				await deps.ops.transition(ownerId, operationId, "running");
				try {
					const result = await run();
					const summary = resultText(result);
					await deps.ops.transition(ownerId, operationId, result?.isError === true ? "failed" : "completed", result?.isError === true ? { error: summary } : { summary });
					await app.guests.log(b, tool.name, "ran", `Used ${tool.name} of ${c.name}`);
					return text(summary, result?.isError === true);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await deps.ops.transition(ownerId, operationId, "needs_reconciliation", { error: message });
					return text(`The call may or may not have reached ${c.name} (${message}). It was not made again.`, true);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (b) await app.guests.log(b, args.tool, "refused", message).catch(() => undefined);
				return text(message, true);
			}
		},
	} as never) as unknown as ToolRegistration;

	return [list, call];
}
