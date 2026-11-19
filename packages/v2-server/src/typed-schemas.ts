/**
 * Tool schemas a non-Claude model behind an Anthropic Messages gateway can take (v1's `src/typed-schemas.ts`). Such a gateway
 * turns each tool's `input_schema` into the other vendor's own form, and Gemini's (Vertex AI's
 * function declarations) is a small part of JSON Schema with rules of its own, which it enforces
 * by refusing the whole request:
 *
 * - every node has a `type` ("schema didn't specify the schema type field");
 * - a node with `anyOf` has nothing else ("When using any_of, it must be the only field set");
 * - `enum` lists strings, on a string;
 * - `format` is one Gemini knows for the node's type;
 * - `required` names only fields in `properties`;
 * - and only the fields of its Schema are known.
 *
 * So each schema is rewritten to those rules. A node's type is its own, or one read from what it
 * holds (`properties`, `items`, `enum`, `const`, `pattern` and the like), or a string's. Local
 * `$ref`s are put in place and `allOf` merged. Branches of `anyOf` or `oneOf` without a type of
 * their own only constrain a node whose type is known, so the fields they name join the node's
 * and the branches go. Other branches stay alternatives: what the node says beside them is
 * carried into each, and a union of literals of one type becomes one `enum`. What Gemini has
 * nothing for, such as `const`, `additionalProperties` or `patternProperties`, is left out, and
 * an `enum` of numbers is said in the description instead.
 *
 * Nothing here is checked on the way back: the tool still checks its arguments against its own
 * schema, which this never changes.
 */

type Schema = Record<string, unknown>;

const isSchema = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

/** The fields of Gemini's Schema, by the type they belong to; `COMMON` belong to every type. */
export const VERTEX_FIELDS: Readonly<Record<string, readonly string[]>> = {
	string: ["enum", "format", "minLength", "maxLength", "pattern"],
	number: ["format", "minimum", "maximum"],
	integer: ["format", "minimum", "maximum"],
	boolean: [],
	array: ["items", "minItems", "maxItems"],
	object: ["properties", "required", "minProperties", "maxProperties"],
};
export const COMMON = ["type", "description", "title", "nullable", "default"];
/** The formats Gemini takes for each type. */
export const VERTEX_FORMATS: Readonly<Record<string, readonly string[]>> = { string: ["enum", "date-time"], number: ["float", "double"], integer: ["int32", "int64"] };

/** How deep `$ref`s are put in place before one is taken for an object, which a recursive schema would never stop at. */
const MAX_REFS = 8;

function jsonType(value: unknown): string {
	if (Array.isArray(value)) return "array";
	if (value === null || value === undefined) return "string";
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
	return typeof value === "object" ? "object" : typeof value;
}

/** The type a node says, or the one what it holds implies; none for a node that says nothing of it. */
function typeOf(node: Schema): string | undefined {
	if (typeof node.type === "string" && node.type !== "null") return node.type;
	if (Array.isArray(node.type)) {
		const type = node.type.find((type): type is string => typeof type === "string" && type !== "null");
		if (type) return type;
	}
	if (["properties", "patternProperties", "required", "minProperties", "maxProperties", "propertyNames"].some((key) => key in node) || isSchema(node.additionalProperties)) return "object";
	if (["items", "prefixItems", "minItems", "maxItems", "uniqueItems", "contains"].some((key) => key in node)) return "array";
	const values = Array.isArray(node.enum) ? node.enum.filter((value) => value !== null) : "const" in node && node.const !== null ? [node.const] : [];
	if (values.length > 0) return jsonType(values[0]);
	if (["pattern", "minLength", "maxLength", "format", "contentEncoding"].some((key) => key in node)) return "string";
	if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => key in node)) return "number";
	return undefined;
}

/** Whether a node allows only `null`, which says nothing Gemini can use. */
const onlyNull = (node: unknown) =>
	isSchema(node) && (node.type === "null" || node.const === null || (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((value) => value === null)));

/** `node` with the fields of `also` it lacks; the two's fields and requirements are joined. */
function joined(node: Schema, also: Schema): Schema {
	const properties = { ...(isSchema(also.properties) ? also.properties : {}), ...(isSchema(node.properties) ? node.properties : {}) };
	const required = [...new Set([...(Array.isArray(also.required) ? also.required : []), ...(Array.isArray(node.required) ? node.required : [])])];
	return { ...also, ...node, ...(Object.keys(properties).length > 0 && { properties }), ...(required.length > 0 && { required }) };
}

function described(node: Schema, description: unknown): Schema {
	return typeof description === "string" && description && node.description === undefined && !("anyOf" in node) ? { ...node, description } : node;
}

/** `schema` in the form Gemini takes (see above). `root` is where its `$ref`s point. Never changes what it is given. */
export function typedSchema(schema: unknown, root: unknown = schema, refs = 0): Schema {
	if (!isSchema(schema)) return { type: "string" };
	const deref = (value: unknown): unknown => {
		if (!isSchema(value) || typeof value.$ref !== "string") return value;
		const { $ref, ...rest } = value;
		const target = refs < MAX_REFS && $ref.startsWith("#/") ? $ref.slice(2).split("/").reduce<unknown>((at, part) => (isSchema(at) ? at[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), root) : undefined;
		return isSchema(target) ? { ...target, ...rest } : { type: "object", ...rest };
	};
	if (typeof schema.$ref === "string") return typedSchema(deref(schema), root, refs + 1);
	let node: Schema = { ...schema };

	// Every branch of `allOf` holds, so they are one node.
	if (Array.isArray(node.allOf)) {
		const { allOf, ...rest } = node;
		node = allOf.map(deref).filter(isSchema).reduce<Schema>((at, branch) => joined(at, branch), rest);
	}

	const branches = [...(Array.isArray(node.anyOf) ? node.anyOf : []), ...(Array.isArray(node.oneOf) ? node.oneOf : [])].map(deref);
	delete node.anyOf;
	delete node.oneOf;
	const own = typeOf(node);
	let alternatives: unknown[] = branches.filter((branch) => !onlyNull(branch));
	if (own !== undefined) {
		// Branches without a type only constrain this node: what fields they name join its own, which come first.
		const typeless = alternatives.filter((branch): branch is Schema => isSchema(branch) && branch.type === undefined && !("const" in branch) && !("enum" in branch));
		for (const branch of typeless) if (isSchema(branch.properties)) node.properties = { ...branch.properties, ...(isSchema(node.properties) ? node.properties : {}) };
		alternatives = alternatives.filter((branch) => !typeless.includes(branch as Schema));
	}
	if (alternatives.length > 0) {
		const { description, ...beside } = node;
		// What the node says beside its alternatives holds for each of them.
		const each = alternatives.map((branch) => (isSchema(branch) ? joined(branch, beside) : { ...beside, type: "string" }));
		const literals = each.every((branch) => "const" in branch || Array.isArray(branch.enum));
		const types = new Set(each.map(typeOf));
		if (each.length > 1 && literals && types.size === 1) {
			const values = [...new Set(each.flatMap((branch) => (Array.isArray(branch.enum) ? branch.enum : [branch.const])).filter((value) => value !== null))];
			return typedSchema({ type: [...types][0], enum: values, ...(description !== undefined && { description }) }, root, refs);
		}
		const all = each.map((branch) => typedSchema(branch, root, refs)).flatMap((branch) => (Array.isArray(branch.anyOf) ? (branch.anyOf as Schema[]) : [branch]));
		// Branches that came out the same, such as two that differed only in what they required, are one.
		const typed = [...new Map(all.map((branch) => [JSON.stringify(branch), branch])).values()];
		if (typed.length === 1) return described(typed[0]!, description);
		return { anyOf: typed.map((branch) => described(branch, description)) };
	}

	const type = own ?? "string";
	const fields = [...COMMON, ...(VERTEX_FIELDS[type] ?? [])];
	const out: Schema = { type };
	for (const key of fields) if (key !== "type" && node[key] !== undefined) out[key] = node[key];
	const notes: string[] = [];
	// Only a string takes an enum, of strings; another type's values are said in its description.
	const values = Array.isArray(node.enum) ? node.enum.filter((value) => value !== null) : "const" in node && node.const !== null ? [node.const] : undefined;
	if (values && values.length > 0) {
		if (type === "string") out.enum = values.map(String);
		else notes.push(`One of: ${values.map((value) => JSON.stringify(value)).join(", ")}.`);
	} else delete out.enum;
	if (out.format !== undefined && !VERTEX_FORMATS[type]?.includes(String(out.format))) delete out.format;
	if (out.nullable !== undefined && typeof out.nullable !== "boolean") delete out.nullable;
	// A default must be of the node's type.
	const fits = out.default !== null && (jsonType(out.default) === type || (type === "number" && jsonType(out.default) === "integer"));
	if (out.default !== undefined && !fits) delete out.default;
	if (notes.length > 0) out.description = [out.description, ...notes].filter((text) => typeof text === "string" && text).join(" ");
	if (type === "object") {
		const properties = isSchema(node.properties) ? node.properties : {};
		if (isSchema(node.properties)) out.properties = Object.fromEntries(Object.entries(properties).map(([name, child]) => [name, typedSchema(child, root, refs)]));
		const required = Array.isArray(node.required) ? node.required.filter((name): name is string => typeof name === "string" && name in properties) : [];
		if (required.length > 0) out.required = [...new Set(required)];
		else delete out.required;
	}
	if (type === "array") {
		const items = Array.isArray(node.items) ? node.items[0] : (node.items ?? (Array.isArray(node.prefixItems) ? node.prefixItems[0] : undefined));
		out.items = typedSchema(items === undefined || typeof items === "boolean" ? {} : items, root, refs);
	}
	return out;
}

/**
 * A model request's context with each tool's schema in the form Gemini takes, for a model that is not Claude (one behind a Messages gateway that translates for Vertex AI).
 * pi-ai carries a transcript's tools in its system messages (`toolsAdded`) as well as in `context.tools`; both are rewritten, as copies: the tool's own schema, which checks
 * the model's arguments, is never changed.
 */
export function withTypedTools<C extends { messages: any[]; tools?: readonly any[] | undefined }>(context: C, model: { id: string }): C {
	if (/^claude/i.test(model.id)) return context;
	const typed = (tools: readonly any[]) => tools.map((tool) => (isSchema(tool?.parameters) ? { ...tool, parameters: typedSchema(tool.parameters) } : tool));
	const declares = (message: any) => message?.role === "system" && Array.isArray(message.toolsAdded) && message.toolsAdded.length > 0;
	if (!context.tools?.length && !context.messages.some(declares)) return context;
	return {
		...context,
		...(context.tools?.length ? { tools: typed(context.tools) } : {}),
		messages: context.messages.map((message) => (declares(message) ? { ...message, toolsAdded: typed(message.toolsAdded) } : message)),
	};
}
