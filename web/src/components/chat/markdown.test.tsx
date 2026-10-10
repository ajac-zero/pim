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
  "",
  "| Day | City |",
  "| --- | --- |",
  "| 1 | Porto |",
  "",
  "```js",
  "const train = 'Porto';",
  "```",
].join("\n");

describe("untrusted Markdown", () => {
  const html = renderToStaticMarkup(<Markdown text={HOSTILE} untrusted />);

  it("keeps the text, tables, code and safe links", () => {
    expect(html).toContain("passport");
    expect(html).toMatch(/<table[\s\S]*Porto[\s\S]*<\/table>/);
    expect(html).toContain("const train");
    expect(html).toContain('href="https://maps.example.com/"');
    expect(html).toContain('href="mailto:a@example.com"');
  });

  it("shows raw HTML as text and no image, so nothing would be fetched", () => {
    // Elements and attributes that would load or run something: none, from Markdown or raw HTML.
    expect(html).not.toMatch(
      /<(img|picture|source|script|iframe|video|audio)\b/,
    );
    expect(html).not.toMatch(/\s(src|srcset)="/);
    // No attribute anywhere names a remote resource from the text (the raw HTML's are only text).
    expect(html).not.toMatch(/="[^"]*evil\.example/);
    // The raw HTML is there only as text.
    expect(html).toContain("&lt;picture&gt;");
    // An image is only its alt text.
    expect(html).toContain("tracker");
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
