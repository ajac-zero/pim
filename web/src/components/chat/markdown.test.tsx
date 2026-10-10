import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "~/components/chat/markdown";

const HOSTILE = [
  "# Trip notes",
  "",
  "Pack the **passport**.",
  "",
  "![tracker](https://evil.example/pixel.png)",
  "",
  "![inline](data:image/png;base64,iVBORw0KGgo=)",
  "",
  '<picture><source srcset="https://evil.example/a.png"><img src="https://evil.example/b.png"></picture>',
  "",
  '<div style="background:url(https://evil.example/c.png)">raw block</div>',
  "",
  '<a href="https://evil.example/raw">raw link</a> <script>alert(1)</script>',
  "",
  "[map](https://maps.example.com) [mail](mailto:a@example.com) [bad](javascript:alert(1)) [data](data:text/html,hi)",
].join("\n");

describe("untrusted Markdown", () => {
  const html = renderToStaticMarkup(<Markdown text={HOSTILE} untrusted />);

  it("keeps the text and safe links", () => {
    expect(html).toContain("passport");
    expect(html).toContain('href="https://maps.example.com/"');
    expect(html).toContain('href="mailto:a@example.com"');
  });

  it("shows raw HTML as text and no image, so nothing would be fetched", () => {
    // Elements and attributes that would load or run something: none, from Markdown or raw HTML.
    expect(html).not.toMatch(
      /<(img|picture|source|script|iframe|video|audio)\b/,
    );
    expect(html).not.toMatch(/\s(src|srcset|style)="/);
    expect(html).not.toMatch(/href="https:\/\/evil/);
    // The raw HTML is there only as text.
    expect(html).toContain("&lt;picture&gt;");
    expect(html).toContain("[tracker]");
  });

  it("keeps no link that isn't to the web or mail", () => {
    expect(html).not.toMatch(/href="(javascript|data):/);
  });

  it("leaves chat Markdown as it was", () => {
    const chat = renderToStaticMarkup(
      <Markdown text={"![a](https://example.com/a.png)"} />,
    );
    expect(chat).not.toContain("[a]");
  });
});
