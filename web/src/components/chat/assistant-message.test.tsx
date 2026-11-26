// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

it("opens its list of models on a tap, as touch has no hover, and says when steps are unknown", () => {
  const { container } = show({
    emitter: neon,
    contributors: [sol, neon],
    complete: false,
  });
  expect(screen.queryByText("Sent by ai-gateway/gemini-4-neon")).toBeNull();
  fireEvent.click(container.querySelector("[data-model]") as Element);
  expect(screen.getByText("Sent by ai-gateway/gemini-4-neon")).toBeTruthy();
  expect(screen.getByText("Also worked on it: openai/gpt-6-sol")).toBeTruthy();
  expect(
    screen.getByText("Some steps before it have no recorded model."),
  ).toBeTruthy();
});

it("opens on hover by mouse", () => {
  const { container } = show({
    emitter: null,
    contributors: [],
    complete: false,
  });
  const badge = container.querySelector("[data-model]") as Element;
  fireEvent.pointerEnter(badge, { pointerType: "mouse" });
  expect(screen.getByText("This message has no recorded model.")).toBeTruthy();
});

it("stays open when a mouse that hovered it clicks it", () => {
  const { container } = show({
    emitter: neon,
    contributors: [neon],
    complete: true,
  });
  const badge = container.querySelector("[data-model]") as Element;
  fireEvent.pointerEnter(badge, { pointerType: "mouse" });
  fireEvent.click(badge);
  expect(screen.getByText("Sent by ai-gateway/gemini-4-neon")).toBeTruthy();
});
