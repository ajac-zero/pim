import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, UNTRUSTED_SCHEMA } from "~/components/chat/markdown";
import { agentsQuery, sessionsQuery } from "~/lib/queries";

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

describe("finished Markdown", () => {
  it("keeps a lone * as written, in a reply and in untrusted text", () => {
    for (const untrusted of [false, true]) {
      const text = renderToStaticMarkup(
        <Markdown
          text={"Pick the *early one.\n\n_Sent from Pim._"}
          untrusted={untrusted}
        />,
      ).replace(/<[^>]*>/g, "");
      expect(text).toContain("Pick the *early one.");
      expect(text.match(/\*/g)).toHaveLength(1);
    }
  });
});

describe("a person's message in their bubble", () => {
  const html = renderToStaticMarkup(
    <Markdown
      bubble
      text={[
        "# Packing",
        "Passport",
        "Charger",
        "",
        "Pick the **cheaper** train, the *early one has too many changes.",
        "",
        "![map](https://example.com/map.png) [the route](https://maps.example.com/)",
      ].join("\n")}
    />,
  );

  it("keeps its line breaks and the Markdown it closes, and leaves a lone * as typed", () => {
    expect(html).toMatch(/Passport<br\/?>\s*Charger/);
    expect(html).toMatch(/font-semibold[^>]*>cheaper</);
    expect(html).not.toContain("**");
    const text = html.replace(/<[^>]*>/g, "");
    expect(text).toContain("the *early one has too many changes.");
    // One `*`, the one typed: nothing added to close it.
    expect(text.match(/\*/g)).toHaveLength(1);
  });

  it("shows headings as bold text, and loads nothing from elsewhere", () => {
    expect(html).not.toMatch(/<h[1-6]/);
    expect(html).toContain('<p class="my-3 font-semibold">Packing</p>');
    expect(elements(html).map((element) => element.tag)).not.toContain("img");
    expect(html).toContain('href="https://maps.example.com/"');
  });
});

describe("an agent's Markdown", () => {
  const own = "/api/images/3f1beb2b-bded-4fda-96cc-1af7192f24b6";
  const html = renderToStaticMarkup(
    <Markdown text={`${HOSTILE}\n\n![kept](${own})`} />,
  );

  it("loads no image but Pim's own", () => {
    const loads = elements(html).flatMap((element) =>
      element.attributes
        .filter(
          (a) =>
            ["src", "srcset", "poster", "data"].includes(a.name) ||
            (a.name === "href" && element.tag !== "a"),
        )
        .map((a) => a.value),
    );
    expect(loads).toContain(own);
    expect(new Set(loads)).toEqual(new Set([own]));
    expect(html).toContain("[tracker]");
  });
});

describe("chats an agent names", () => {
  const chat = "7af6a6ec-9d58-489a-b2be-512eda1cb34b";
  // An artifact's id, say: no chat of the person's.
  const other = "0b5e8f9c-1d2e-4f3a-8b7c-6d5e4f3a2b1c";

  async function render(
    text: string,
    path = "/",
    streaming = false,
    bubble = false,
  ) {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionsQuery().queryKey, [
      {
        id: chat,
        title: "Autumn trip",
        busy: false,
        createdAt: 0,
        updatedAt: 0,
        visit: null,
        agent: { id: "p_scout", name: "Scout" },
      },
    ] as never);
    queryClient.setQueryData(agentsQuery().queryKey, []);
    const root = createRootRoute({
      component: () => (
        <>
          <Markdown text={text} streaming={streaming} bubble={bubble} />
          <Outlet />
        </>
      ),
    });
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: "/chat/$sessionId" }),
      ]),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    await router.load();
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it("links a chat by its id, bare, in backticks or as its address, and shows its title", async () => {
    const links = (html: string) =>
      [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(
        ([, href, text]) => [href, String(text).replace(/<[^>]+>/g, "")],
      );
    const html = await render(
      `Asked Scout in chat ${chat}, also \`${chat}\` and /chat/${chat}. See [the plan](/chat/${chat}) and artifact ${other}.`,
    );
    expect(links(html)).toEqual([
      [`/chat/${chat}`, "Autumn trip"],
      [`/chat/${chat}`, "Autumn trip"],
      [`/chat/${chat}`, "Autumn trip"],
      [`/chat/${chat}`, "the plan"],
    ]);
    // An id that isn't a chat stays as it was written.
    expect(html).toContain(`artifact ${other}.`);
    // Also while the message streams in, with its words in spans of their own.
    const streamed = await render(`chat ${chat} and /chat/${chat}`, "/", true);
    expect(streamed).toContain("data-sd-animate");
    expect(links(streamed)).toEqual([
      [`/chat/${chat}`, "Autumn trip"],
      [`/chat/${chat}`, "Autumn trip"],
    ]);

    // A person's own message names chats the same way, and still links nowhere else in the app.
    const typed = await render(
      `Like in ${chat}, see [export](/api/account/export)`,
      "/",
      false,
      true,
    );
    expect(links(typed)).toEqual([[`/chat/${chat}`, "Autumn trip"]]);
  });

  it("opens an artifact an agent links to beside the chat, in this window, even by an address it made up", async () => {
    const links = (html: string) =>
      [...html.matchAll(/<a [^>]*>[\s\S]*?<\/a>/g)].map(([tag]) => [
        /href="([^"]*)"/.exec(tag)?.[1]?.replaceAll("&amp;", "&"),
        tag.includes('target="_blank"'),
      ]);
    const text = `See [the plan](/artifacts/${other}), [version 2](/artifacts/${other}?v=2), [it](artifact://${other}) and [elsewhere](https://other.example/artifacts/${other}).`;
    expect(links(await render(text, `/chat/${chat}`))).toEqual([
      [`/chat/${chat}?artifact=${other}`, false],
      [`/chat/${chat}?artifact=${other}&v=2`, false],
      [`/chat/${chat}?artifact=${other}`, false],
      [`https://other.example/artifacts/${other}`, true],
    ]);
    // Outside a chat, on the artifact's own page.
    expect(links(await render(text))[0]).toEqual([
      `/artifacts/${other}`,
      false,
    ]);
  });
});
