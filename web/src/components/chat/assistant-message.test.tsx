// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AssistantMessage } from "~/components/chat/items";
import type { MessageItem } from "~/lib/openresponses";

afterEach(cleanup);

const item: MessageItem = {
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "Hello" }],
};

const neon = { provider: "ai-gateway", model: "gemini-4-neon" };
const sol = { provider: "openai", model: "gpt-6-sol" };

const show = (
  provenance: Parameters<typeof AssistantMessage>[0]["provenance"],
) => render(<AssistantMessage item={item} provenance={provenance} />);

it("labels a message with the model that emitted it and counts the others behind it", () => {
  const { container } = show({
    emitter: neon,
    contributors: [sol, neon],
    complete: true,
  });
  const badge = container.querySelector("[data-model]");
  expect(badge?.textContent).toBe("gemini-4-neon +1");
  expect(badge?.getAttribute("data-model")).toBe("ai-gateway/gemini-4-neon");
});

it("says the model is unknown for a message that recorded none, instead of naming one", () => {
  show({ emitter: null, contributors: [], complete: false });
  expect(screen.getByText("Model unknown")).toBeTruthy();
});

it("shows no label for a message with no provenance, as what others said in a group chat", () => {
  const { container } = show(undefined);
  expect(container.querySelector("[data-model]")).toBeNull();
});
