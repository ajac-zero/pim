import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { Composer } from "~/components/chat/composer";
import { artifactQuery } from "~/lib/queries";

it("renders an artifact prefix by title while leaving the request editable, and keeps unknown references as text", () => {
  const id = "0b5e8f9c-1d2e-4f3a-8b7c-6d5e4f3a2b1c";
  const client = new QueryClient();
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  const render = (initialInput: string) =>
    renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Composer initialInput={initialInput} busy={false} onSend={() => {}} />
      </QueryClientProvider>,
    );
  const input = (html: string) =>
    /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1];
  try {
    const reference = `/artifacts/${id}?v=2\n\n`;
    expect(input(render(`${reference}Add a lunch stop.`))).toBe(
      `${reference}Add a lunch stop.`,
    );
    client.setQueryData(artifactQuery(id).queryKey, {
      id,
      title: "Weekend plan",
      kind: "markdown",
    } as never);
    const html = render(`${reference}Add a lunch stop.`);
    expect(html).toContain("Weekend plan");
    expect(html).toContain('aria-label="Remove artifact Weekend plan"');
    expect(input(html)).toBe("Add a lunch stop.");
    expect(input(render("An ordinary draft."))).toBe("An ordinary draft.");
  } finally {
    vi.unstubAllGlobals();
    client.clear();
  }
});
