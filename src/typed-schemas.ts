/**
 * Tool schemas a non-Claude model behind an Anthropic Messages gateway can take. Such a gateway
 * turns each tool's `input_schema` into the other vendor's own form, and Gemini's (Vertex AI's
 * function declarations) wants a `type` on every schema node: it refuses a request with "schema
 * didn't specify the schema type field". JSON Schema doesn't need one, and connectors' schemas
 * often go without, as in an `anyOf` of branches that only say which fields are required.
 *
 * So every node gets a `type`: its own, or one read from what it holds, or a string's. Branches
 * of `anyOf`, `oneOf` or `allOf` without a type of their own only constrain a node whose type is
 * known, so the properties they name join the node's and the branches go; local `$ref`s are put
 * in place. The one node left without a type is one whose branches are of different types, such
 * as a string or a number: each branch has its type, which is how Gemini takes alternatives.
 * Nothing here is checked again on the way back: the tool still checks its arguments against its
 * own schema, which this never changes.
 */

type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

/** What can't add a type, only rule values out, and has nothing like it in Gemini's schemas. */
const CONSTRAINTS_ONLY = ["not", "if", "then", "else", "dependentSchemas"];
const BRANCHES = ["anyOf", "oneOf", "allOf"] as const;
/** How deep `$ref`s are put in place before one is taken for an object, which a recursive schema would never stop at. */
const MAX_REFS = 8;

function jsonType(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null || value === undefined) return "string";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value === "object" ? "object" : typeof value === "bigint" ? "integer" : typeof value;
}

/** The type a node says, or the one what it holds implies; none for a node that says nothing of it. */
function typeOf(node: Schema): string | undefined {
	if (typeof node.type === "string") return node.type;
	if (Array.isArray(node.type)) return node.type.find((type): type is string => typeof type === "string" && type !== "null");
	if (["properties", "patternProperties", "required", "minProperties", "maxProperties", "propertyNames"].some((key) => key in node) || isSchema(node.additionalProperties)) return "object";
	if (["items", "prefixItems", "minItems", "maxItems", "uniqueItems", "contains"].some((key) => key in node)) return "array";
	const values = Array.isArray(node.enum) ? node.enum.filter((value) => value !== null) : "const" in node ? [node.const] : [];
	if (values.length > 0) return jsonType(values[0]);
	if (["pattern", "minLength", "maxLength", "format", "contentEncoding"].some((key) => key in node)) return "string";
	if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => key in node)) return "number";
	return undefined;
}

/** `schema` with every node typed (see above). `root` is where its `$ref`s point. Never changes what it is given. */
export function typedSchema(schema: unknown, root: unknown = schema, refs = 0): Schema {
	if (!isSchema(schema)) return { type: "string" };
	let node: Schema = { ...schema };
	// A local `$ref` is put in place, beside whatever the node says itself.
	if (typeof node.$ref === "string") {
		const target = node.$ref.startsWith("#/") ? node.$ref.slice(2).split("/").reduce<unknown>((at, part) => (isSchema(at) ? at[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), root) : undefined;
		const { $ref: _ref, ...rest } = node;
		node = refs < MAX_REFS && isSchema(target) ? { ...target, ...rest } : { type: "object", ...rest };
		if (refs < MAX_REFS && isSchema(target)) return typedSchema(node, root, refs + 1);
	}
	for (const key of [...CONSTRAINTS_ONLY, "$defs", "definitions", "$schema"]) delete node[key];
	if (Array.isArray(node.type)) node.type = typeOf(node) ?? "string";

	const own = typeOf(node);
	for (const key of BRANCHES) {
		const branches = node[key];
		if (!Array.isArray(branches)) continue;
		const resolved = branches.map((branch) => (isSchema(branch) && typeof branch.$ref === "string" ? typedSchema(branch, root, refs) : branch));
		const typeless = resolved.filter((branch) => isSchema(branch) && branch.type === undefined) as Schema[];
		if (own !== undefined || key === "allOf") {
			// Branches without a type only constrain this node: what properties they name join its own, which come first.
			const kept = resolved.filter((branch) => !typeless.includes(branch as Schema));
			const merged = typeless.reduce<Schema>((props, branch) => ({ ...(isSchema(branch.properties) ? branch.properties : {}), ...props }), isSchema(node.properties) ? node.properties : {});
			if (Object.keys(merged).length > 0) node.properties = merged;
			if (key === "allOf") {
				// Every branch of `allOf` holds, so a typed one's fields are this node's too.
				for (const branch of kept.filter(isSchema)) {
					if (isSchema(branch.properties)) node.properties = { ...branch.properties, ...(isSchema(node.properties) ? node.properties : {}) };
					if (Array.isArray(branch.required)) node.required = [...new Set([...(Array.isArray(node.required) ? node.required : []), ...branch.required])];
					node.type ??= typeOf(branch);
				}
				for (const branch of typeless) if (Array.isArray(branch.required)) node.required = [...new Set([...(Array.isArray(node.required) ? node.required : []), ...branch.required])];
				delete node[key];
			} else if (kept.length > 0) node[key] = kept;
			else delete node[key];
		} else {
			// Alternatives: each gets its type; a null one says nothing Gemini can use.
			const alternatives = resolved.filter((branch) => !(isSchema(branch) && (branch.type === "null" || (Array.isArray(branch.enum) && branch.enum.every((value) => value === null)))));
			if (alternatives.length === 1 && isSchema(alternatives[0])) {
				const { [key]: _branches, ...rest } = node;
				node = { ...alternatives[0], ...rest };
			} else node[key] = alternatives.length > 0 ? alternatives : resolved;
		}
	}

	for (const key of ["properties", "patternProperties", "$defs", "definitions"]) {
		if (isSchema(node[key])) node[key] = Object.fromEntries(Object.entries(node[key]).map(([name, child]) => [name, typedSchema(child, root, refs)]));
	}
	if (isSchema(node.additionalProperties)) node.additionalProperties = typedSchema(node.additionalProperties, root, refs);
	if (Array.isArray(node.items)) node.items = node.items.map((item) => typedSchema(item, root, refs));
	else if (node.items !== undefined && typeof node.items !== "boolean") node.items = typedSchema(node.items, root, refs);
	if (Array.isArray(node.prefixItems)) node.prefixItems = node.prefixItems.map((item) => typedSchema(item, root, refs));
	for (const key of BRANCHES) if (Array.isArray(node[key])) node[key] = (node[key] as unknown[]).map((branch) => typedSchema(branch, root, refs));

	if (node.type === undefined) {
		const alternatives = (node.anyOf ?? node.oneOf) as Schema[] | undefined;
		const types = new Set(alternatives?.map((branch) => branch.type));
		// Alternatives of one type give it to the node; of several, the node is left to its branches.
		if (!alternatives || types.size === 1) node.type = typeOf(node) ?? (alternatives ? alternatives[0]!.type : "string");
	}
	if (node.type === "array" && node.items === undefined) node.items = { type: "string" };
	return node;
}

/** A Messages request with each tool's `input_schema` typed throughout; the rest of it is left as it is. */
export function withTypedToolSchemas<P>(params: P): P {
	const tools = (params as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return params;
	return { ...params, tools: tools.map((tool) => (isSchema(tool) && isSchema(tool.input_schema) ? { ...tool, input_schema: typedSchema(tool.input_schema) } : tool)) };
}
