import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  AgentPreviewBanner,
  agentPreviewText,
} from "~/components/agent-preview-banner";

const NOW = Date.UTC(2026, 9, 29, 12, 0);

const page = (preview: Parameters<typeof AgentPreviewBanner>[0]["preview"]) =>
  renderToStaticMarkup(
    <AgentPreviewBanner preview={preview} now={NOW}>
      <p>the app</p>
    </AgentPreviewBanner>,
  );

it("leaves the app exactly as it is when the mode is absent", () => {
  expect(page(undefined)).toBe("<p>the app</p>");
});

it("shows the banner to a human's session, with no expiry", () => {
  const html = page({ enabled: true });
  expect(html).toContain("UNSAFE PREVIEW — agent access enabled");
  expect(html).toContain("<p>the app</p>");
  expect(html).not.toContain("automation session");
});

it("says when an automation session ends, and when it has", () => {
  expect(
    agentPreviewText({ enabled: true, expiresAt: NOW + 600_000 }, NOW),
  ).toBe(
    "UNSAFE PREVIEW — agent access enabled · automation session ends 12:10 UTC",
  );
  expect(agentPreviewText({ enabled: true, expiresAt: NOW }, NOW)).toBe(
    "UNSAFE PREVIEW — agent access enabled · automation session expired",
  );
});
