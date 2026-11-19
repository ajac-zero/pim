/**
 * What a model costs per million tokens, by the id it is served under, for the endpoints pi-ai's catalog does not price: a person's own OpenAI-compatible or Anthropic-compatible
 * server and a gateway (v1's `config/model-prices.json`, version 2026-11-10.1, and its `priceOf`). Each row is the input, output, cache read and 5-minute cache write price, in dollars; a
 * model with no separate cache write price (null) adds nothing for them. A price a person sets for their own endpoint's model comes first (`compatibleProvider`).
 */
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

const TABLE: Record<string, [input: number, output: number, cacheRead: number, cacheWrite: number | null]> = {
	"claude-opus-5-5": [4, 20, 0.2, 5],
	"claude-sonnet-5-5": [2, 10, 0.2, 2.5],
	"claude-haiku-5-5": [1, 5, 0.1, 1.25],
	"claude-fable-5-1": [10, 50, 1, 12.5],
	"gpt-6-astra": [10, 50, 1, 12.5],
	"gpt-6.1-sol": [2, 10, 0.1, 2.5],
	"gpt-6-luna": [0.1, 0.5, 0.01, 0.125],
	"gpt-5.6-terra": [2, 12, 0.2, 2.5],
	"gpt-5.5": [5, 30, 0.5, null],
	"gpt-5.4-mini": [0.75, 4.5, 0.075, null],
	"gemini-3.5-flash": [1.5, 9, 0.15, null],
	"gemini-3.8-flash": [1.5, 7.5, 0.15, null],
	"deepseek-v4.1-flash": [0.14, 0.28, 0.014, null],
	"deepseek-v4-pro": [0.55, 2.19, 0.055, null],
	"grok-4.6": [2, 6, 0.5, null],
};

/** Ids compared loosely: case, a gateway prefix (`anthropic/`, `@cf/`), a `:tag`, a date or `-latest` suffix, and `.`/`-`/`_` in version numbers don't matter. */
const canonical = (id: string) =>
	id
		.toLowerCase()
		.slice(id.lastIndexOf("/") + 1)
		.replace(/:[^:]*$/, "")
		.replace(/-(latest|\d{8}|\d{4}-\d{2}-\d{2})$/, "")
		.replace(/[._]/g, "-");

/** The price of a model by the id it is seen under: exactly, or by its normalised id. Undefined for a model the table does not know. */
export function priceOf(model: string): Price | undefined {
	const row = TABLE[model] ?? TABLE[model.slice(model.lastIndexOf("/") + 1)] ?? Object.entries(TABLE).find(([id]) => canonical(id) === canonical(model))?.[1];
	return row && { input: row[0], output: row[1], cacheRead: row[2], cacheWrite: row[3] ?? 0 };
}
