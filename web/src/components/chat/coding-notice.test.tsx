// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EventNotice } from "~/components/chat/items";
import { noticeOf } from "~/lib/pim-view";

afterEach(cleanup);

const show = (text: string) => {
  const notice = noticeOf(text);
  if (!notice) throw new Error("not a notice");
  return render(<EventNotice notice={notice} />);
};

describe("a coding thread's turn ending in the chat", () => {
  it("shows the thread, state, short commit and link, with what it said folded", () => {
    const { container } = show(
      "[Coding thread abc123] It finished its turn.\nState: idle. Spent $0.10.\nLink: /coding/abc123\nIts changes are committed as 0123456789ab.\nIt last said:\nAll done.\nLook with coding_status.",
    );
    const card = container.querySelector("[data-notice=coding]");
    expect(card?.textContent).toContain(
      "Coding thread abc123 finished its turn",
    );
    expect(card?.querySelector("[data-part=state]")?.textContent).toBe("idle");
    expect(card?.querySelector("[data-part=commit]")?.textContent).toBe(
      "0123456",
    );
    expect(card?.querySelector("a")?.getAttribute("href")).toBe(
      "/coding/abc123",
    );
    expect(screen.queryByText("All done.")).toBeNull();
    fireEvent.click(screen.getByText("It last said"));
    expect(screen.getByText("All done.")).toBeTruthy();
  });

  it("omits the commit and the fold when the message has neither", () => {
    const { container } = show(
      "[Coding thread t9] It was cancelled.\nState: failed. Spent $0.\nLink: /coding/t9",
    );
    expect(container.querySelector("[data-part=commit]")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[data-part=state]")?.textContent).toBe(
      "failed",
    );
  });
});
