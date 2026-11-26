// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ModelSwitchNotice } from "~/components/chat/items";
import { i18nFor } from "~/components/i18n";

afterEach(cleanup);

const fallback = {
  kind: "fallback",
  from: "gemini-4-neon",
  to: "gpt-6.1-sol",
  cause: "stalled",
} as const;

it("is one short line the screen reader reads as a note, with its icon left out of it", () => {
  const { container } = render(
    <ModelSwitchNotice notice={{ kind: "retry", model: "gemini-4-neon" }} />,
  );
  const note = screen.getByRole("note");
  expect(note.textContent).toBe(
    "gemini-4-neon stopped responding; trying it once more",
  );
  expect(note.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelector("button")).toBeNull();
  expect(note.className).toContain("text-muted-foreground");
});

it("names both models of a fallback, and words one that was unavailable differently from one that stalled", () => {
  const { rerender } = render(<ModelSwitchNotice notice={fallback} />);
  expect(screen.getByRole("note").textContent).toBe(
    "gemini-4-neon stalled twice; continuing with gpt-6.1-sol for the rest of this turn",
  );
  rerender(<ModelSwitchNotice notice={{ ...fallback, cause: "failed" }} />);
  expect(screen.getByRole("note").textContent).toBe(
    "gemini-4-neon wasn't available; continuing with gpt-6.1-sol for the rest of this turn",
  );
});

it("is worded in Spanish too, with the same models", () => {
  const { t } = i18nFor("es");
  expect(t("modelRetryNotice", { model: "a" })).toBe(
    "a dejó de responder; se lo pide una vez más",
  );
  expect(t("modelStalledNotice", { from: "a", to: "b" })).toBe(
    "a se detuvo dos veces; se continúa con b el resto de este turno",
  );
  expect(t("modelFailedNotice", { from: "a", to: "b" })).toBe(
    "a no estaba disponible; se continúa con b el resto de este turno",
  );
});
