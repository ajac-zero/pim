/**
 * The catalog of native components a ```ui block may draw, version 2: the
 * tags, their props and what each is for. The web app has a React component
 * for each tag and nothing else renders, so a block can only draw what is
 * here. The same table checks a block at compile time, describes the
 * language to the model (`uiBlockReference`) and says what each prop is.
 */

/** What a prop's value is, as written in a tag. */
export type PropKind = "string" | "number" | "boolean" | "strings" | "enum" | "list" | "actions";

export type PropSpec = {
	kind: PropKind;
	/** For `enum` props, the words the value must be one of. */
	values?: readonly string[];
	/** The block is not valid without it. */
	required?: boolean;
	description: string;
};

/** What may go between a tag and its end. */
export type Children = "text" | "any" | "rows" | "cells" | "none";

export type TagSpec = {
	description: string;
	props: Record<string, PropSpec>;
	children: Children;
};

export const CATALOG_VERSION = 2;

/** The tags a ```ui block may use, with their props. */
export const CATALOG: Record<string, TagSpec> = {
	box: {
		description: "Things stacked, or in a row with row={true}.",
		props: {
			row: { kind: "boolean", description: "Lay the things out side by side instead of stacked." },
			gap: { kind: "number", description: "Space between the things, in units of the app's spacing." },
			padding: { kind: "number", description: "Space inside the box." },
			border: { kind: "boolean", description: "Draw the box's hairline border." },
			tone: { kind: "enum", values: ["default", "muted"], description: "The surface: the page's own, or one step off it." },
		},
		children: "any",
	},
	text: {
		description: "A line of text.",
		props: {
			tone: { kind: "enum", values: ["default", "muted"], description: "Body text, or muted text." },
		},
		children: "text",
	},
	title: {
		description: "A short heading for a piece of the block.",
		props: {},
		children: "text",
	},
	table: {
		description: "A table of rows; give its head the column titles. Its cells may hold input fields.",
		props: {
			head: { kind: "strings", description: "The column titles." },
		},
		children: "rows",
	},
	row: {
		description: "One row of a table.",
		props: {},
		children: "cells",
	},
	cell: {
		description: "One cell of a row: text, or an input field.",
		props: {},
		children: "any",
	},
	form: {
		description: "A form its fields answer: it can be submitted once every required field is filled in, then checks each field that has an answer, shows the marks and locks itself.",
		props: {
			id: { kind: "string", required: true, description: "The form's own id, which names its answers in later turns." },
			title: { kind: "string", description: "What the form is called, in its summary and its fallback text." },
			submitLabel: { kind: "string", description: "The submit button's label; default \"Submit\"." },
			onSubmit: { kind: "actions", description: "What submitting does, such as [reveal(), issueNewTurn(formSummary(\"id\"))]." },
		},
		children: "any",
	},
	number: {
		description: "A number the person types. With answer (and tol, the absolute error allowed) it is checked on submit.",
		props: {
			name: { kind: "string", required: true, description: "The field's name within its form." },
			label: { kind: "string", description: "What the field is called, shown above it and in the form's summary." },
			answer: { kind: "number", description: "The number it is checked against." },
			tol: { kind: "number", description: "How far off it may be; default 0, exact." },
			explain: { kind: "string", description: "Shown with the mark when the answer is wrong." },
			required: { kind: "boolean", description: "Whether the form can be submitted with this field empty; default true, so every field must be filled in. Write required={false} for an optional one." },
		},
		children: "none",
	},
	input: {
		description: "A line of text the person types. With answer it is checked on submit, trimmed and regardless of case.",
		props: {
			name: { kind: "string", required: true, description: "The field's name within its form." },
			label: { kind: "string", description: "What the field is called, shown above it and in the form's summary." },
			placeholder: { kind: "string", description: "A hint shown in the empty field." },
			answer: { kind: "string", description: "The text it is checked against." },
			explain: { kind: "string", description: "Shown with the mark when the answer is wrong." },
			required: { kind: "boolean", description: "Whether the form can be submitted with this field empty; default true, so every field must be filled in. Write required={false} for an optional one." },
		},
		children: "none",
	},
	select: {
		description: "A choice of options. With answer it is checked on submit, exactly.",
		props: {
			name: { kind: "string", required: true, description: "The field's name within its form." },
			label: { kind: "string", description: "What the field is called, shown above it and in the form's summary." },
			options: { kind: "strings", required: true, description: "The choices, in order." },
			answer: { kind: "string", description: "The option it is checked against." },
			explain: { kind: "string", description: "Shown with the mark when the answer is wrong." },
			required: { kind: "boolean", description: "Whether the form can be submitted with this field empty; default true, so every field must be filled in. Write required={false} for an optional one." },
		},
		children: "none",
	},
	checkbox: {
		description: "A box the person ticks. Outside a form it is state named name, a true or false that {@let} values can read; in a form it is a field. With answer it is checked on submit.",
		props: {
			name: { kind: "string", required: true, description: "The state's name, or the field's name within its form." },
			label: { kind: "string", description: "What the box is called, shown beside it and in the form's summary." },
			answer: { kind: "boolean", description: "Whether it should be ticked, checked on submit." },
			explain: { kind: "string", description: "Shown with the mark when the answer is wrong." },
			required: { kind: "boolean", description: "Whether the form can be submitted with this box unticked; default false. Write required={true} for a box that must be ticked." },
		},
		children: "none",
	},
	slider: {
		description: "A number the person picks along a range, shown beside the slider. Outside a form it is state named name, a number that {@let} values can read; in a form it is a field. Not checked unless it has an answer.",
		props: {
			name: { kind: "string", required: true, description: "The state's name, or the field's name within its form." },
			label: { kind: "string", description: "What the slider is called, shown above it and in the form's summary." },
			min: { kind: "number", required: true, description: "The lowest value." },
			max: { kind: "number", required: true, description: "The highest value; above min." },
			step: { kind: "number", description: "The distance between values; default 1." },
			value: { kind: "number", description: "What it starts at; default min." },
			unit: { kind: "string", description: "Shown after the value, such as \"seats\"." },
			answer: { kind: "number", description: "The number it is checked against on submit." },
			tol: { kind: "number", description: "How far off it may be; default 0, exact." },
			explain: { kind: "string", description: "Shown with the mark when the answer is wrong." },
		},
		children: "none",
	},
	badge: {
		description: "A small label, such as a status.",
		props: {
			tone: { kind: "enum", values: ["default", "muted", "good", "bad", "warn"], description: "What the label means: neutral, quiet, good, bad or a warning." },
		},
		children: "text",
	},
	chart: {
		description: "A chart of a list, drawn again as the state it reads changes, with its data as a table for those who can't see it.",
		props: {
			kind: { kind: "enum", values: ["bar", "line", "pie"], required: true, description: "The kind of chart." },
			data: { kind: "list", required: true, description: "A list of numbers, or of tables with the x and y names as keys, such as [{month: \"Jan\", sales: 4}]." },
			x: { kind: "string", description: "The key of each table that labels it; not needed for a list of numbers." },
			y: { kind: "string", description: "The key of each table that holds its number; not needed for a list of numbers." },
			title: { kind: "string", description: "What the chart shows." },
		},
		children: "none",
	},
	button: {
		description: "A button that acts without the model: copy something, show a form's answers, or send a turn.",
		props: {
			onClick: { kind: "actions", description: "What clicking does, such as [copy(\"x\")] or [issueNewTurn(\"…\")]." },
		},
		children: "text",
	},
};

/** How a prop's kind is written in the model's reference. */
function propSyntax(spec: PropSpec): string {
	switch (spec.kind) {
		case "string":
			return '"text"';
		case "number":
			return "{5}";
		case "boolean":
			return "{true}";
		case "strings":
			return '["a", "b"]';
		case "enum":
			return spec.values ? spec.values.map((value) => `"${value}"`).join(" | ") : "enum";
		case "list":
			return "{list}";
		case "actions":
			return "[action(), …]";
	}
}

/** The builtins an expression may call, for the model's reference. */
export const BUILTINS: Record<string, string> = {
	abs: "abs(x)",
	round: "round(x)",
	floor: "floor(x)",
	ceil: "ceil(x)",
	min: "min(a, b, …)",
	max: "max(a, b, …)",
	sum: "sum(list)",
	len: "len(list or text)",
	map: "map(list, \"prop\")",
	filter: "filter(list, \"prop\")",
	join: "join(list, \"sep\")",
	str: "str(x)",
	num: "num(x)",
	close: "close(a, b, tol)",
	eq: "eq(a, b)",
	submitted: 'submitted("formId")',
	score: 'score("formId")',
	count: 'count("formId")',
	formSummary: 'formSummary("formId")',
};

/** The actions a handler may run. */
export const ACTIONS: Record<string, string> = {
	reveal: "reveal(): show this form's answers and marks.",
	issueNewTurn: 'issueNewTurn(text): send the person\'s turn, such as issueNewTurn(formSummary("formId")).',
	copy: "copy(text): put text on the clipboard.",
};

/** A ```ui block the model can copy the shape of, checked by Pim's own tests. */
export const UI_EXAMPLE = [
	'<form id="knn" submitLabel="Check and send" onSubmit={[reveal(), issueNewTurn(formSummary("knn"))]}>',
	'  <table head={["Point", "Label", "d²"]}>',
	'    <row><cell>(1, 1)</cell><cell>A</cell><cell><number name="d1" answer={5} tol={0.01} explain="(2-1)²+(3-1)²"/></cell></row>',
	'    <row><cell>(4, 5)</cell><cell>B</cell><cell><number name="d2" answer={13} tol={0.01}/></cell></row>',
	"  </table>",
	'  <select name="pred" label="Predicted label" options={["A", "B"]} answer="A"/>',
	'  {#if submitted("knn")}<text>Score: {score("knn")} / {count("knn")}</text>{/if}',
	"</form>",
].join("\n");

/**
 * The model's compact reference to the ```ui language, generated from the
 * catalog so it can't drift: the tags with their props, the expression
 * builtins, the actions, and one whole example.
 */
export function uiBlockReference(): string {
	const tags = Object.entries(CATALOG).map(([tag, spec]) => {
		const props = Object.entries(spec.props).map(([name, prop]) =>
			`${name}${prop.required ? "" : "?"}=${propSyntax(prop)}`,
		);
		const head = `<${tag}${props.length > 0 ? ` ${props.join(" ")}` : ""}>`;
		const body = spec.children === "none" ? " (self-closing)" : "…</" + tag + ">";
		return `- ${head}${body}: ${spec.description}`;
	});
	const builtins = Object.values(BUILTINS).join(", ");
	const actions = Object.entries(ACTIONS).map(([name, what]) => `${name}: ${what}`).join(" ");
	return [
		"To draw a small interactive piece in the chat, such as a quiz, a checklist or a form, put a ```ui block alone on its lines: Markdown text plus the native components below. It is compiled and checked when you send, and what is wrong comes back to you to fix; it renders as drawn components, never as code, and its fallback (email, API clients) reads as plain Markdown.",
		`The components (v${CATALOG_VERSION}):`,
		...tags,
		`Plain text inside the block is Markdown. {expr} interpolates an expression: literals, + - * / % == != < <= > >= && || ! ?:, member and index access, and the builtins ${builtins}. An expression that reads a form is checked again as the person fills it in.`,
		'A statement sits alone on its line: {@state name = expr} declares state the person can change (input values are state too), {@let name = expr} a value derived each time. A <checkbox> or <slider> outside a form is state of its own name (a true or false, a number) that expressions read and that charts and text follow live, such as {@state seats = 8} <slider name="seats" min={1} max={50}/> {@let price = seats * 29}; <chart kind="bar" data={rows} x="k" y="v"/> draws a list of tables, and sum(map(rows, "v")) adds up one of their keys. Blocks: {#if expr}…{:else}…{/if} and {#each list as item, i}…{/each}.',
		`A handler is an action list, such as onSubmit={[reveal(), issueNewTurn(formSummary("id"))]}. Actions: ${actions}. Pim runs them in the app without asking you, so keep them to what the person is doing.`,
		"Example:",
		UI_EXAMPLE,
	].join("\n");
}
