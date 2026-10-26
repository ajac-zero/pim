import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserView } from "~/components/chat/browser-view";
import { browserClosedStatus } from "~/lib/pim-api";

// The dropdown drawn open, as when the person expands it: a static render draws no closed content.
vi.mock("~/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => children,
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  CollapsibleContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

const render = (takeOver: boolean, asleep = false) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <BrowserView
        sessionId="chat-1"
        page={{
          url: "https://example.com/",
          title: "Example",
          ...(asleep && { asleep }),
        }}
        takeOver={takeOver}
        updatedAt={0}
      />
    </QueryClientProvider>,
  );

describe("the chat's browser window", () => {
  it("offers Take over where the space allows it", () => {
    const html = render(true);
    expect(html).toContain('href="/browser?session=chat-1"');
    expect(html).toContain("Take over");
    expect(html).not.toContain("isn&#x27;t available");
  });

  it("says taking over isn't available, with no link to it, where the space refuses it", () => {
    for (const asleep of [false, true]) {
      const html = render(false, asleep);
      expect(html).not.toContain('href="/browser');
      expect(html).not.toContain("Take over");
      expect(html).toContain("Taking over isn&#x27;t available in this space");
    }
  });
});

describe("the takeover page, once the browser's socket closes", () => {
  it("says taking over isn't available on the space's refusal, and that the window closed otherwise", () => {
    expect(browserClosedStatus(4005)).toBe("unavailable");
    for (const code of [1000, 1006, 4000, 4004])
      expect(browserClosedStatus(code)).toBe("closed");
  });
});
