/**
 * What the native-app MCP client (./native-mcp.ts) takes from upstream,
 * pinned to one commit of https://github.com/trycua/cua and never fetched:
 * the `/mcp` handshake of spacesd 0.7.0 and its linked cua-driver 0.38.0, and
 * the input schema of each tool the client may call, as the Linux registry
 * (`platform_linux::register_tools_with_cursor`, which spacesd links on
 * Linux) declares it. docs/cua-native-mcp.md says where each comes from.
 *
 * `UPSTREAM_TOOLS` copies, for each curated tool, the properties the client
 * allows and the `required` list, with every keyword but `description`, as
 * the source's `json!` blocks and schema helpers build them. A client that
 * sets up a run checks them against what the daemon's `tools/list`
 * advertises, so a daemon whose schema differs is refused before any call.
 */

/** The upstream commit: the cua-spacesd 0.7.0 release. */
export const CUA_COMMIT = "fca21937bc4e1420a23d544d11dbdf987f0266e6";

/** The `/mcp` path (`cua_proto::metadata::MCP_PATH`). */
export const MCP_PATH = "/mcp";

/** `initialize_result()` in cua-driver-core's `protocol.rs`: the legacy protocol version, answered as is. */
export const PROTOCOL_VERSION = "2025-06-18";

/** `serverInfo` in that answer: cua-driver-core's own name and crate version (the cua-driver workspace's 0.38.0). */
export const SERVER_INFO = { name: "cua-driver", version: "0.38.0" } as const;

/** The headers spacesd's `/mcp` reads (`http/mcp.rs`): the transport session it answers with, and the agent run whose driver session a call acts in. */
export const SESSION_HEADER = "mcp-session-id";
export const AGENT_SESSION_HEADER = "x-cua-agent-session";

/** The MCP session spacesd mints when a request names none: `mcp-` and `random_id(12)`, 12 random bytes in unpadded URL-safe base64. */
export const MINTED_SESSION = /^mcp-[A-Za-z0-9_-]{16}$/;

/** What `X-Cua-Agent-Session` must be for spacesd to use it (`driver_session`): 1 to 64 of these. Anything else falls back to the MCP session. */
export const AGENT_SESSION = /^[A-Za-z0-9._:-]{1,64}$/;

/** The one content type spacesd answers JSON-RPC with (`json()` in `http/mcp.rs`). */
export const JSON_TYPE = "application/json";

/** `value` and everything in it frozen, so what is exported can't be changed by whoever imports it. */
export function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) deepFreeze(item);
	}
	return value;
}

/** A property's schema in a tool's advertised `inputSchema`, without its `description`. */
export type UpstreamProperty = Readonly<Record<string, unknown>>;
export type UpstreamTool = {
	/** Where the tool's `ToolDef` is, at `CUA_COMMIT`. */
	readonly source: string;
	readonly required: readonly string[];
	readonly properties: Readonly<Record<string, UpstreamProperty>>;
};

const IMPL = "libs/cua-driver/rust/crates/platform-linux/src/tools/impl_.rs";
const integer = { type: "integer" } as const;
const number = { type: "number" } as const;
const boolean = { type: "boolean" } as const;
const string = { type: "string" } as const;
/** `tool_schema::element_token_schema()`. */
const elementToken = { type: "string", pattern: "^s[0-9a-f]{8}:[0-9]+$" } as const;
/** `input::delivery::delivery_mode_schema()` on Linux: `tool_schema::delivery_mode_schema_with` plus its default. */
const deliveryMode = { type: "string", enum: ["background", "foreground"], default: "background" } as const;

/**
 * The curated tools' pinned schemas. Every other tool the registry has is
 * left out on purpose (docs/cua-native-mcp.md, "What isn't curated").
 */
export const UPSTREAM_TOOLS: Readonly<Record<string, UpstreamTool>> = deepFreeze({
	list_apps: { source: `${IMPL}#L276`, required: [], properties: {} },
	list_windows: {
		source: `${IMPL}#L553`,
		required: [],
		properties: { pid: integer, app: string, on_screen_only: boolean },
	},
	get_window_state: {
		source: `${IMPL}#L1049`,
		required: ["pid"],
		properties: {
			pid: integer,
			window_id: integer,
			include_accessibility_tree: boolean,
			include_screenshot: boolean,
			query: string,
			max_elements: { type: "integer", minimum: 1 },
			max_depth: { type: "integer", minimum: 1 },
			// `tool_schema::timeout_ms_schema()`.
			timeout_ms: { type: "integer", minimum: 100, maximum: 120_000, default: 1000 },
			// `window_state_view::schema_properties()`, which `extend_input_schema` adds.
			tree_format: { type: "string", enum: ["markdown", "elements", "both"] },
			since: string,
		},
	},
	bring_to_front: {
		source: `${IMPL}#L14498`,
		required: ["pid"],
		properties: { pid: integer, window_id: integer },
	},
	click: {
		source: `${IMPL}#L6509`,
		required: [],
		properties: {
			pid: integer,
			window_id: integer,
			x: number,
			y: number,
			element_token: elementToken,
			button: { type: "string", enum: ["left", "right", "middle"] },
			count: { type: "integer", minimum: 1 },
			delivery_mode: deliveryMode,
		},
	},
	type_text: {
		source: `${IMPL}#L7582`,
		required: ["text"],
		properties: { pid: integer, window_id: integer, text: string, element_token: elementToken, x: number, y: number, delivery_mode: deliveryMode },
	},
	press_key: {
		source: `${IMPL}#L8522`,
		required: ["key"],
		properties: {
			pid: integer,
			window_id: integer,
			key: string,
			modifiers: { type: "array", items: string },
			element_token: elementToken,
			x: number,
			y: number,
			delivery_mode: deliveryMode,
		},
	},
	hotkey: {
		source: `${IMPL}#L8951`,
		required: ["keys"],
		properties: {
			pid: integer,
			window_id: integer,
			keys: { type: "array", items: string, minItems: 2 },
			element_token: elementToken,
			x: number,
			y: number,
			delivery_mode: deliveryMode,
		},
	},
	scroll: {
		source: `${IMPL}#L9854`,
		required: ["direction"],
		properties: {
			pid: integer,
			direction: { type: "string", enum: ["up", "down", "left", "right"] },
			by: { type: "string", enum: ["line", "page"] },
			amount: { type: "integer", minimum: 1, maximum: 50 },
			window_id: integer,
			element_token: elementToken,
			x: number,
			y: number,
			delivery_mode: deliveryMode,
		},
	},
});

/** The SHA-256 of `UPSTREAM_TOOLS` as canonical JSON (keys sorted), which docs/cua-native-mcp.md records beside the source's blob ids. */
export const UPSTREAM_TOOLS_SHA256 = "3a599e8c2dc90fda821d2c03d69d6bc758ed668e6b3cf133f66ad3c77305b19a";
