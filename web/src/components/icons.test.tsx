import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessIcon } from "~/components/harness-icon";
import { Bell } from "~/components/icons";

describe("themed icons", () => {
  it("keeps decorative icons silent and preserves labels and SVG props for meaningful icons", () => {
    const decorative = renderToStaticMarkup(<Bell />);
    expect(decorative).toMatch(/^<svg[^>]*aria-hidden="true"/);

    const meaningful = renderToStaticMarkup(
      <Bell
        aria-label="Notifications"
        role="img"
        size={18}
        className="text-muted-foreground"
      />,
    );
    expect(meaningful).toMatch(/^<svg[^>]*aria-label="Notifications"/);
    expect(meaningful).not.toMatch(/^<svg[^>]*aria-hidden="true"/);
    expect(meaningful).toContain('width="18"');
    expect(meaningful).toContain('height="18"');
    expect(meaningful).toContain("text-muted-foreground");
  });
});

describe("harness logos", () => {
  it("draws each harness's own mark, labeled with its name", () => {
    const marks = (["pi", "claude-code", "codex"] as const).map((harness) =>
      renderToStaticMarkup(<HarnessIcon harness={harness} />),
    );
    expect(marks.map((mark) => /aria-label="([^"]+)"/.exec(mark)?.[1])).toEqual(
      ["Pi", "Claude Code", "Codex"],
    );
    for (const mark of marks) expect(mark).toMatch(/^<svg[^>]*role="img"/);
    // Each draws something different, not one mark under three names.
    const drawings = marks.map((mark) => mark.replace(/^<svg[^>]*>/, ""));
    expect(new Set(drawings).size).toBe(3);
    expect(marks[1]).toContain('fill="#d97757"');
  });
});
