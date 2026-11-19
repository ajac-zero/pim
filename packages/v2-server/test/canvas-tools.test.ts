// The canvas tools without a deployment: the app that has the chat open is told to open a file (a notice), is asked what is open and selected and answers over the Live socket
// (`canvas_answer`), and the files are the person's, on their computer. The Relay's bus and the notices' bus are in memory.
import { describe, expect, it } from "vitest";
import { Notices } from "@pim/v2-app/notices";
import type { RelayBus, RelayReply, RelayRequest } from "@pim/v2-app/relay";
import { canvasTools } from "../src/canvas-tools.ts";

const OWNER = "o_ada";
const CHAT = "chat-1";

/** The tools, run as the chat's agent. `computer` answers the computer's calls; `app` is what the browser does with a notice. */
function rig(options: { computer?: boolean; app?: (notice: { kind: string; data: any }, answer: (data: object) => void) => void } = {}) {
	const notices = new Notices();
	const published: { kind: string; data: any }[] = [];
	const calls: RelayRequest[] = [];
	let said: ((owner: string, said: { kind: string; data?: unknown; connection: string }) => void) | undefined;
	notices.connect((owner, notice) => {
		published.push(notice as never);
		options.app?.(notice as never, (data) => said?.(owner, { kind: "canvas_answer", data, connection: "c1" }));
	}, (handler) => ((said = handler), () => (said = undefined)));
	const bus = {
		request: async (_owner: string, request: RelayRequest): Promise<RelayReply> => {
			calls.push(request);
			if (options.computer === false) throw new Error("nobody");
			if (request.op === "info") return { ok: true, result: { protocol: 2 } };
			return { ok: true, result: { isDirectory: String((request as { args?: { path?: string } }).args?.path).endsWith("/dir") } };
		},
	} as unknown as RelayBus;
	const app = { notices, identity: { authz: { enforce: async () => undefined } } } as never;
	const read = (_name: string, _description: string, _parameters: unknown, run: (app: never, call: never, args: never) => Promise<unknown>) => ({ name: _name, run }) as never;
	const tools = canvasTools({ ownerId: OWNER, read, relay: async () => bus }) as unknown as { name: string; run: (app: never, call: never, args: never) => Promise<{ output: { text: string }[]; isError?: boolean }> }[];
	const use = async (name: string, args: object, chat: string | null = CHAT) => {
		const result = await tools.find((t) => t.name === name)!.run(app, { chat, p: { kind: "agent", ownerId: OWNER, agentId: "pim" } } as never, args as never);
		return { text: result.output[0]!.text, isError: result.isError === true };
	};
	return { use, published, calls };
}

describe("the canvas tools", () => {
	it("tells the app that has the chat open to open a file, at a line, and refuses what is not one of the person's files", async () => {
		const { use, published } = rig();
		expect((await use("canvas_open_file", { path: "/workspace/src/a.ts", line: 12 })).text).toMatch(/^Asked the app showing this chat to open \/workspace\/src\/a\.ts at line 12/);
		expect(published).toEqual([{ kind: "canvas_open", data: { session: CHAT, path: "/workspace/src/a.ts", line: 12 } }]);
		expect(await use("canvas_open_file", { path: "/etc/passwd" })).toMatchObject({ isError: true, text: expect.stringMatching(/not one of the person's files/) });
		expect(await use("canvas_open_file", { path: "/workspace/dir" })).toMatchObject({ isError: true, text: "/workspace/dir is not a file." });
		expect(published).toHaveLength(1);
	});

	it("asks the app what is open and what is selected, and says so when no app answers", async () => {
		const answering = rig({
			app: (notice, answer) => {
				if (notice.kind !== "canvas_query") return;
				if (notice.data.what === "tabs") answer({ request: notice.data.request, tabs: [{ path: "/workspace/a.ts", dirty: true }, { path: "/workspace/b.ts", dirty: false }], active: "/workspace/b.ts" });
				else answer({ request: notice.data.request, active: "/workspace/b.ts", selection: { path: "/workspace/b.ts", from: { line: 3, column: 1 }, to: { line: 4, column: 9 }, text: "const x = 1;\nreturn x;" } });
			},
		});
		expect((await answering.use("canvas_list_open", {})).text).toBe("/workspace/a.ts (unsaved changes)\n/workspace/b.ts (shown)");
		expect((await answering.use("canvas_get_selection", {})).text).toBe("/workspace/b.ts: selected from line 3, column 1 to line 4, column 9\nconst x = 1;\nreturn x;");
		expect(answering.published.map((n) => [n.kind, n.data.session, n.data.what])).toEqual([["canvas_query", CHAT, "tabs"], ["canvas_query", CHAT, "selection"]]);
		// No app has the chat open: nothing answers within the time, and the agent is told to link the file instead.
		const silent = rig();
		expect((await silent.use("canvas_list_open", {}, null)).text).toMatch(/^No app has this chat open right now/);
	});

	it("needs the person's computer, which holds the files the canvas shows", async () => {
		const none = rig({ computer: false });
		for (const [name, args] of [["canvas_open_file", { path: "/workspace/a.ts" }], ["canvas_list_open", {}], ["canvas_get_selection", {}]] as const) {
			expect(await none.use(name, args)).toMatchObject({ isError: true, text: expect.stringMatching(/needs a paired personal computer[\s\S]*Settings → Computer/) });
		}
		expect(none.published).toEqual([]);
	});
});
