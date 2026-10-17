import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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
