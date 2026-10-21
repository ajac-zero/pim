import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	defineExtension,
	GenerationTask,
	hook,
	type Registry,
	type ToolRegistration,
	type UserInput,
} from "@earendil-works/pi-durable";
import { type AttributeValue, type Attributes, type Context, ROOT_CONTEXT, type Span, SpanKind, SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter, TracerProvider } from "@opentelemetry/sdk-trace";

/**
 * Pim's traces, in OpenTelemetry's semantic conventions for generative AI
 * (https://github.com/open-telemetry/semantic-conventions-genai), so any
 * backend that reads them (Langfuse, Phoenix, Grafana, Honeycomb, Jaeger)
 * shows what an agent did and why.
 *
 * Each run of a conversation is an `invoke_agent` span; each model request
 * in it a `chat` span, and each tool call an `execute_tool` span. Work a
 * tool call starts in another conversation is a child of that call: a task
 * handed to another agent, or the majordomo's review of an
 * approval request. So one trace holds everything a message to an agent led
 * to, up to the tasks' answers, which come back later in a trace of their own.
 *
 * Off unless the deployment sets an OTLP endpoint. Prompts, messages and
 * tool arguments and results are recorded only when
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` is `true`, as the
 * conventions ask.
 */

export const TELEMETRY_EXTENSION = "pim.telemetry";

/** The OpenTelemetry variables Pim reads; the headers are a secret, as they carry the backend's key. */
export type TelemetryEnv = {
	readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string;
	readonly OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
	readonly OTEL_EXPORTER_OTLP_HEADERS?: string;
	readonly OTEL_EXPORTER_OTLP_TRACES_HEADERS?: string;
	readonly OTEL_SERVICE_NAME?: string;
	readonly OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT?: string;
};

/** Exports spans as OTLP/HTTP JSON to `url`, the protocol Workers can send without protobuf code generation. */
export function otlpExporter(url: string, headers: Record<string, string>): SpanExporter {
	return {
		export(spans: ReadableSpan[], done) {
			const body = JsonTraceSerializer.serializeRequest(spans);
			fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) })
				.then(async (response) => {
					if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
					done({ code: ExportResultCode.SUCCESS });
				})
				.catch((error: unknown) => {
					console.warn("exporting traces failed", error);
					done({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) });
				});
		},
		async shutdown() {},
	};
}

/** The exporter the deployment's OTLP variables ask for, as the OpenTelemetry specification reads them; null when unset. */
export function exporterFrom(env: TelemetryEnv): SpanExporter | null {
	const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
	const url = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() || (base ? `${base.replace(/\/$/, "")}/v1/traces` : "");
	if (!url) return null;
	const headers: Record<string, string> = {};
	for (const pair of (env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
		const at = pair.indexOf("=");
		if (at > 0) headers[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(pair.slice(at + 1).trim());
	}
	return otlpExporter(url, headers);
}

/** Who works in a conversation, as its spans name it. */
export type AgentRef = { readonly id: string; readonly name: string };

type Run = { readonly span: Span; readonly context: Context; operations: number; chat?: Span };

export class Telemetry {
	readonly #provider: TracerProvider | null;
	readonly #tracer: Tracer | null;
	readonly #content: boolean;
	readonly #agentOf: (conversation: string) => AgentRef;
	/** The id a conversation goes by outside the space, which its spans give it. */
	readonly #idOf: (conversation: string) => string;
	/** Open runs, by conversation. In memory: a run resumed after an eviction starts a new trace. */
	readonly #runs = new Map<string, Run>();
	/** The tool call whose execution is under way, so work it submits elsewhere joins its trace. */
	readonly #active = new AsyncLocalStorage<Context>();

	constructor(options: { exporter: SpanExporter | null; content: boolean; service: string; instance: string; agentOf: (conversation: string) => AgentRef; idOf: (conversation: string) => string }) {
		this.#content = options.content;
		this.#agentOf = options.agentOf;
		this.#idOf = options.idOf;
		this.#provider = options.exporter
			? new TracerProvider({
					resource: resourceFromAttributes({ "service.name": options.service, "service.instance.id": options.instance }),
					spanProcessors: [new BatchSpanProcessor({ exporter: options.exporter })],
				})
			: null;
		this.#tracer = this.#provider?.getTracer("pim") ?? null;
	}

	/** Whether traces go anywhere. */
	get enabled(): boolean {
		return this.#tracer !== null;
	}

	/**
	 * Called as input goes to `conversation`, before pi can start on it: it
	 * starts a run, or joins the one going, which ends when every input in
	 * it has settled. Input submitted while a tool call executes is that
	 * call's child. The returned function takes it back when pi doesn't
	 * accept it, as with a retried operation; a span never ended is never sent.
	 */
	submitting(conversation: string, input: UserInput, from: string): () => void {
		if (!this.#tracer) return () => undefined;
		const joined = this.#runs.get(conversation);
		if (joined) {
			joined.operations++;
			joined.span.addEvent("pim.input", { "pim.input.from": from, ...this.#capture("gen_ai.input.messages", () => [{ role: "user", parts: parts(input) }]) });
			return () => void this.settled(conversation, { status: "done" });
		}
		const agent = this.#agentOf(conversation);
		const span = this.#tracer.startSpan(
			`invoke_agent ${agent.name}`,
			{
				kind: SpanKind.INTERNAL,
				attributes: {
					"gen_ai.operation.name": "invoke_agent",
					"gen_ai.agent.id": agent.id,
					"gen_ai.agent.name": agent.name,
					"gen_ai.conversation.id": this.#idOf(conversation),
					"pim.input.from": from,
					...this.#capture("gen_ai.input.messages", () => [{ role: "user", parts: parts(input) }]),
				},
			},
			this.#active.getStore() ?? ROOT_CONTEXT,
		);
		const run: Run = { span, context: trace.setSpan(ROOT_CONTEXT, span), operations: 1 };
		this.#runs.set(conversation, run);
		return () => {
			if (--run.operations === 0 && this.#runs.get(conversation) === run) this.#runs.delete(conversation);
		};
	}

	/** Called when one input to `conversation` settles; the run ends with the last, and its spans are sent. */
	async settled(conversation: string, outcome: { status: string; reason?: string }): Promise<void> {
		const run = this.#runs.get(conversation);
		if (!run) return;
		if (outcome.status !== "done") {
			run.span.setAttribute("error.type", outcome.reason ?? outcome.status);
			run.span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.reason ?? outcome.status });
		}
		if (--run.operations > 0) return;
		run.chat?.end();
		run.span.end();
		this.#runs.delete(conversation);
		if (this.#runs.size === 0) await this.#provider?.forceFlush();
	}

	/** Model requests' spans, through pi's generation hooks: selected by every conversation. */
	extension() {
		return defineExtension({
			name: TELEMETRY_EXTENSION,
			hooks: [
				hook(GenerationTask, {
					beforeRequest: ({ messages }, api) => {
						if (!this.#tracer) return undefined;
						const conversation = String(api.conversationId);
						const run = this.#runs.get(conversation);
						// A retry's request replaces the one that failed.
						run?.chat?.end();
						const span = this.#tracer.startSpan(
							"chat",
							{
								kind: SpanKind.CLIENT,
								attributes: {
									"gen_ai.operation.name": "chat",
									"gen_ai.conversation.id": this.#idOf(conversation),
									...this.#capture("gen_ai.system_instructions", () => instructions(messages)),
									...this.#capture("gen_ai.input.messages", () => messages.flatMap(semconvMessage)),
								},
							},
							run?.context ?? ROOT_CONTEXT,
						);
						if (run) run.chat = span;
						else span.setAttribute("pim.run.unknown", true);
						return undefined;
					},
					afterResponse: (message, api) => {
						const run = this.#runs.get(String(api.conversationId));
						const span = run?.chat;
						if (!span) return;
						run.chat = undefined;
						endChat(span, message, this.#capture("gen_ai.output.messages", () => semconvMessage(message)));
					},
				}),
			],
		});
	}

	/** `registry`, with every tool it installs traced: each call is an `execute_tool` span, in the run that made it. */
	instrument<R extends Registry>(registry: R): R {
		const wrap = (tool: ToolRegistration) => this.#tool(tool);
		return new Proxy(registry, {
			get(target, property) {
				if (property === "install") {
					return (extension: Parameters<Registry["install"]>[0]) =>
						target.install(extension.tools ? { ...extension, tools: extension.tools.map(wrap) } : extension);
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	#tool(tool: ToolRegistration): ToolRegistration {
		const telemetry = this;
		const execute: ToolRegistration["execute"] = async function (args, api, context) {
			const tracer = telemetry.#tracer;
			if (!tracer) return tool.execute(args, api, context);
			const conversation = String(api.conversationId);
			const parent = telemetry.#runs.get(conversation)?.context ?? ROOT_CONTEXT;
			const span = tracer.startSpan(
				`execute_tool ${tool.name}`,
				{
					kind: SpanKind.INTERNAL,
					attributes: {
						"gen_ai.operation.name": "execute_tool",
						"gen_ai.tool.name": tool.name,
						"gen_ai.tool.call.id": api.callId,
						"gen_ai.tool.type": "function",
						"gen_ai.conversation.id": telemetry.#idOf(conversation),
						...telemetry.#capture("gen_ai.tool.call.arguments", () => args),
					},
				},
				parent,
			);
			try {
				const result = await telemetry.#active.run(trace.setSpan(parent, span), () => tool.execute(args, api, context));
				if (result.isError) {
					span.setAttribute("error.type", "tool_error");
					span.setStatus({ code: SpanStatusCode.ERROR, message: textOf(result.content ?? []) });
				}
				span.setAttributes(telemetry.#capture("gen_ai.tool.call.result", () => textOf(result.content ?? [])));
				return result;
			} catch (error) {
				span.recordException(error instanceof Error ? error : String(error));
				span.setAttribute("error.type", error instanceof Error ? error.name : "_OTHER");
				span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
				throw error;
			} finally {
				span.end();
			}
		};
		return new Proxy(tool, { get: (target, property) => (property === "execute" ? execute : Reflect.get(target, property, target)) });
	}

	/** A content attribute, only when the deployment opted in; recorded as JSON, as the conventions allow on spans. */
	#capture(key: string, value: () => unknown): Attributes {
		if (!this.#content) return {};
		try {
			const content = value();
			return { [key]: (typeof content === "string" ? content : JSON.stringify(content)) as AttributeValue };
		} catch {
			return {};
		}
	}
}

function endChat(span: Span, message: AssistantMessage, content: Attributes): void {
	const { usage } = message;
	span.updateName(`chat ${message.model}`);
	span.setAttributes({
		"gen_ai.provider.name": message.provider,
		"gen_ai.request.model": message.model,
		...(message.responseModel ? { "gen_ai.response.model": message.responseModel } : {}),
		...(message.responseId ? { "gen_ai.response.id": message.responseId } : {}),
		"gen_ai.response.finish_reasons": [finishReason(message.stopReason)],
		"gen_ai.usage.input_tokens": usage.input + usage.cacheRead + usage.cacheWrite,
		"gen_ai.usage.output_tokens": usage.output,
		"gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
		"gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite,
		...content,
	});
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		span.setAttribute("error.type", message.stopReason);
		span.setStatus({ code: SpanStatusCode.ERROR, message: message.errorMessage ?? message.stopReason });
	}
	span.end();
}

/** pi's stop reasons as the conventions name them. */
function finishReason(stopReason: AssistantMessage["stopReason"]): string {
	return stopReason === "toolUse" ? "tool_call" : stopReason;
}

const textOf = (content: readonly { type: string; text?: string }[]) => content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");

/** Message parts in the conventions' schema; images are named, not copied. */
function parts(content: UserInput | AssistantMessage["content"]): unknown[] {
	if (typeof content === "string") return [{ type: "text", content }];
	return content.map((part) => {
		switch (part.type) {
			case "text":
				return { type: "text", content: part.text };
			case "image":
				return { type: "blob", modality: "image", mime_type: part.mimeType };
			case "thinking":
				return { type: "reasoning", content: part.thinking };
			case "toolCall":
				return { type: "tool_call", id: part.id, name: part.name, arguments: part.arguments };
		}
	});
}

/** One of pi's messages in the conventions' schema; system messages are instructions, not messages. */
function semconvMessage(message: Message): unknown[] {
	switch (message.role) {
		case "user":
			return [{ role: "user", parts: parts(message.content) }];
		case "assistant":
			return [{ role: "assistant", parts: parts(message.content), finish_reason: finishReason(message.stopReason) }];
		case "toolResult":
			return [{ role: "tool", parts: [{ type: "tool_call_response", id: message.toolCallId, response: textOf(message.content) }] }];
		default:
			return [];
	}
}

/** The system prompt a request carries: every system message's instructions, then their sections as they are by the end. */
function instructions(messages: readonly Message[]): unknown[] {
	const text: string[] = [];
	const sections = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		const content = typeof message.content === "string" ? message.content : textOf(message.content);
		if (content !== "") text.push(content);
		for (const [name, value] of Object.entries(message.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
	}
	return [{ type: "text", content: [...text, ...sections.values()].join("\n\n") }];
}
