import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, UNTRUSTED_SCHEMA } from "~/components/chat/markdown";

/** Everything Markdown or raw HTML could use to load, run or send something. */
const HOSTILE = [
  "# Trip notes",
  "",
  "Pack the **passport**.",
  "",
  // Markdown images: remote, protocol-relative, relative, inline.
  "![tracker](https://evil.example/pixel.png) ![proto](//evil.example/p.png) ![rel](/api/export) ![inline](data:image/png;base64,iVBORw0KGgo=)",
  "",
  // Raw HTML of every kind that can reach out.
  '<picture><source srcset="https://evil.example/a.png 1x"><img src="https://evil.example/b.png" srcset="https://evil.example/c.png 2x"></picture>',
  "",
  '<video poster="https://evil.example/poster.png" src="https://evil.example/v.mp4"><source src="https://evil.example/v.webm"></video>',
  "",
  '<audio src="https://evil.example/a.mp3" autoplay></audio>',
  "",
  '<iframe src="https://evil.example/frame"></iframe>',
  "",
  '<object data="https://evil.example/o.swf"></object><embed src="https://evil.example/e.swf">',
  "",
  '<link rel="stylesheet" href="https://evil.example/s.css"><style>body{background:url(https://evil.example/s.png)}</style>',
  "",
  '<div style="background:url(https://evil.example/d.png)" onclick="alert(1)">raw block</div>',
  "",
  '<form action="https://evil.example/f"><input type="image" src="https://evil.example/i.png"><button formaction="https://evil.example/b">go</button></form>',
  "",
  '<a href="https://evil.example/raw">raw link</a> <script>alert(1)</script>',
  "",
  // Links: allowed, and every kind that isn't.
  "[map](https://maps.example.com) [mail](mailto:a@example.com) [top](#trip-notes)",
  "[js](javascript:alert(1)) [data](data:text/html,hi) [rel](/api/account/export) [dot](./x) [proto](//evil.example/l)",
  "",
  "- [ ] buy tickets",
  "",
  "| Day | City |",
  "| --- | --- |",
  "| 1 | Porto |",
  "",
  "```js",
  "const train = 'Porto';",
  "```",
].join("\n");

/** Every element in the markup, with its attributes. */
function elements(html: string) {
  return [
    ...html.matchAll(
      /<([a-z][a-z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/gi,
    ),
  ].map(([, tag, attributes = ""]) => ({
    tag: String(tag).toLowerCase(),
    attributes: [...attributes.matchAll(/\s([^\s=]+)(?:="([^"]*)")?/g)].map(
      ([, name, value = ""]) => ({
        name: String(name).toLowerCase(),
        value,
      }),
    ),
  }));
}

describe("untrusted Markdown", () => {
  const html = renderToStaticMarkup(<Markdown text={HOSTILE} untrusted />);
  const found = elements(html);

  it("keeps the text, task lists, tables, code and safe links", () => {
    expect(html).toContain("passport");
    expect(html).toMatch(/<table[\s\S]*Porto[\s\S]*<\/table>/);
    expect(html).toContain("const train");
    const hrefs = found.flatMap((element) =>
      element.attributes.filter((a) => a.name === "href").map((a) => a.value),
    );
    expect(hrefs).toEqual([
      "https://maps.example.com/",
      "mailto:a@example.com",
      "#trip-notes",
    ]);
  });

  it("leaves no element that loads, embeds, runs or submits anything", () => {
    const tags = new Set(found.map((element) => element.tag));
    for (const tag of [
      "img",
      "picture",
      "source",
      "video",
      "audio",
      "iframe",
      "object",
      "embed",
      "link",
      "style",
      "script",
      "form",
      "meta",
      "base",
    ]) {
      expect(tags.has(tag), tag).toBe(false);
    }
    // Buttons only as the app's own (the code block's copy button), never from the text.
    expect(
      found.filter((element) => element.tag === "button").length,
    ).toBeLessThanOrEqual(1);
    // Inputs only as the disabled checkboxes of task lists.
    for (const input of found.filter((element) => element.tag === "input")) {
      expect(input.attributes).toContainEqual({
        name: "type",
        value: "checkbox",
      });
    }
  });

  it("leaves no attribute that loads, runs or sends anything", () => {
    for (const { tag, attributes } of found) {
      for (const { name, value } of attributes) {
        expect(
          [
            "src",
            "srcset",
            "poster",
            "data",
            "action",
            "formaction",
            "background",
            "xlink:href",
          ],
          `${tag} ${name}`,
        ).not.toContain(name);
        expect(name.startsWith("on"), `${tag} ${name}`).toBe(false);
        // The only style attributes are the code block's own colours, never a URL.
        if (name === "style") expect(value, tag).not.toMatch(/url\(/i);
        // No attribute carries an address from the text but the allowed links.
        expect(value, `${tag} ${name}`).not.toMatch(
          /evil\.example|\/api\/|javascript:|data:/i,
        );
      }
    }
  });

  it("shows raw HTML as text, and images as their alt text only", () => {
    expect(html).toContain("&lt;picture&gt;");
    expect(html).toContain("&lt;iframe");
    expect(html).toContain("[Image blocked: tracker]");
    expect(html).toContain("[Image blocked: inline]");
  });

  it("is shaped by Pim's own allowlist, which on its own permits nothing that loads or runs", () => {
    // Each layer holds by itself: the link filter and Streamdown's hardening come after this.
    expect(UNTRUSTED_SCHEMA.protocols).toEqual({
      href: ["http", "https", "mailto"],
    });
    for (const tag of ["img", "a", "input"])
      expect(UNTRUSTED_SCHEMA.tagNames).toContain(tag);
    for (const tag of [
      "picture",
      "source",
      "video",
      "audio",
      "iframe",
      "object",
      "embed",
      "link",
      "style",
      "script",
      "form",
      "button",
      "svg",
      "math",
    ]) {
      expect(UNTRUSTED_SCHEMA.tagNames).not.toContain(tag);
    }
    expect(UNTRUSTED_SCHEMA.attributes.img).toEqual(["alt"]);
    expect(UNTRUSTED_SCHEMA.attributes.a).toEqual(["href"]);
    expect(Object.keys(UNTRUSTED_SCHEMA.attributes)).not.toContain("*");
  });

  it("leaves chat Markdown as it was", () => {
    const chat = renderToStaticMarkup(
      <Markdown text={"![a](https://example.com/a.png)"} />,
    );
    expect(chat).not.toContain("Image blocked");
  });
});
