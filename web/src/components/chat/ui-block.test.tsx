// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserMessage } from "~/components/chat/items";
import { Markdown } from "~/components/chat/markdown";
import { ReplyImages } from "~/components/chat/reply-blocks";
import type { MessageItem } from "~/lib/openresponses";
import { type UiResponse, uiTurn } from "../../../../src/ui-lang";
import { UI_EXAMPLE } from "../../../../src/ui-lang/catalog";

afterEach(cleanup);

/** A block, in a message that can send turns the way the chat does. */
function shown(
  source: string,
  {
    send,
    submitted,
    streaming = false,
  }: {
    send?: (text: string) => Promise<void>;
    submitted?: ReadonlyMap<string, UiResponse>;
    streaming?: boolean;
  } = {},
) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ReplyImages
        images={{}}
        streaming={streaming}
        send={send}
        submitted={submitted}
        messageId="m1"
      >
        <Markdown text={`\`\`\`ui\n${source}\n\`\`\``} />
      </ReplyImages>
    </QueryClientProvider>,
  );
}

const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "Check and send" }));

/** A field of the form, by the key its state is kept under. */
const field = (key: string) =>
  document.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[data-field="${key}"] input, [data-field="${key}"] select`,
  ) as HTMLInputElement | HTMLSelectElement;

const fillAll = () => {
  fireEvent.change(field("knn.d1"), { target: { value: "5" } });
  fireEvent.change(field("knn.d2"), { target: { value: "7" } });
  fireEvent.change(field("knn.pred"), { target: { value: "B" } });
};

const submitButton = () =>
  screen.getByRole("button", {
    name: "Check and send",
  }) as HTMLButtonElement;

describe("a ui block in a reply", () => {
  it("draws its table and form, keeping its answers off the page", () => {
    const { container } = shown(UI_EXAMPLE);
    expect(container.textContent).toContain("(1, 1)");
    expect(container.textContent).toContain("Predicted label");
    expect(screen.getByRole("button", { name: "Check and send" })).toBeTruthy();
    // Neither the answers nor their explanations are anywhere in the markup.
    expect(
      document.querySelector('[data-field="knn.d2"]')?.innerHTML,
    ).not.toContain("13");
    expect(container.innerHTML).not.toContain("0.01");
    expect(container.innerHTML).not.toContain("(2-1)²+(3-1)²");
  });

  it("falls back to readable Markdown, with a note, when it can't be drawn", () => {
    const { container } = shown('<form id="x"><chart/></form>');
    expect(container.textContent).toContain("Form x");
    expect(container.textContent).toContain("couldn't be shown");
    expect(container.textContent).toContain(
      "<chart> is not one of the components",
    );
  });

  it("grades what was filled in, locks the form and sends exactly one turn", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    shown(UI_EXAMPLE, { send });
    fireEvent.change(field("knn.d1"), { target: { value: "5" } });
    fireEvent.change(field("knn.d2"), { target: { value: "7" } });
    fireEvent.change(field("knn.pred"), { target: { value: "B" } });
    submit();
    // The marks show, with what was expected where it was wrong.
    expect(screen.getAllByLabelText("Wrong")).toHaveLength(2);
    expect(screen.getAllByLabelText("Correct")).toHaveLength(1);
    await waitFor(() => expect(screen.getByText(/Expected 13/)).toBeTruthy());
    expect(screen.getByText(/Score: 1 \/ 3/)).toBeTruthy();
    // The form is locked: nothing can be changed or sent again.
    expect(field("knn.d1").disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Check and send",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    submit();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const turn = send.mock.calls[0]?.[0] ?? "";
    // The turn reads as Markdown, and its answers ride in a hidden trailer.
    expect(turn).toContain("Form knn");
    expect(turn).toContain("| d1 | 5 ✓ |");
    expect(turn).toContain("Score: 1 / 3");
    expect(turn).toContain("```ui-response");
    const response: UiResponse = JSON.parse(
      /```ui-response\n([\s\S]*?)\n```/.exec(turn)?.[1] ?? "{}",
    );
    expect(response).toEqual({
      block: "knn",
      messageId: "m1",
      values: { "knn.d1": "5", "knn.d2": "7", "knn.pred": "B" },
      graded: { "knn.d1": true, "knn.d2": false, "knn.pred": false },
    });
  });

  it("unlocks the form and says so when the send fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    shown(UI_EXAMPLE, { send });
    fillAll();
    submit();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("Couldn't send");
    // Unlocked: the person can change their answer and send again.
    expect(field("knn.d1").disabled).toBe(false);
    submit();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });

  it("keeps submit disabled, with a hint, until every required field is filled", () => {
    shown(UI_EXAMPLE);
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Fill in every field to submit")).toBeTruthy();
    fireEvent.change(field("knn.d1"), { target: { value: "5" } });
    fireEvent.change(field("knn.pred"), { target: { value: "B" } });
    expect(submitButton().disabled).toBe(true);
    // A number field must hold a finite number.
    fireEvent.change(field("knn.d2"), { target: { value: "1e999" } });
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(field("knn.d2"), { target: { value: "7" } });
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByText("Fill in every field to submit")).toBeNull();
  });

  it("lets a field marked required={false} stay blank", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    shown(
      [
        '<form id="f" submitLabel="Check and send" onSubmit={[issueNewTurn(formSummary("f"))]}>',
        '  <input name="a" label="A"/><input name="note" label="Note" required={false}/>',
        "</form>",
      ].join("\n"),
      { send },
    );
    expect(submitButton().disabled).toBe(true);
    fireEvent.change(field("f.a"), { target: { value: "x" } });
    expect(submitButton().disabled).toBe(false);
    submit();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it("sends once however many times a filled form is submitted", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    shown(UI_EXAMPLE, { send });
    fillAll();
    submit();
    submit();
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(submitButton().disabled).toBe(true);
  });

  it("re-locks a form its chat already answered, without sending anything", () => {
    const send = vi.fn();
    const response: UiResponse = {
      block: "knn",
      values: { "knn.d1": "5", "knn.d2": "13", "knn.pred": "A" },
      graded: { "knn.d1": true, "knn.d2": true, "knn.pred": true },
    };
    const { container } = shown(UI_EXAMPLE, {
      send,
      submitted: new Map([["knn", response]]),
    });
    expect(field("knn.d1").disabled).toBe(true);
    expect((field("knn.d1") as HTMLInputElement).value).toBe("5");
    expect(screen.getByText(/Score: 3 \/ 3/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain("```ui-response");
  });

  it("shows a placeholder while the message is still arriving", () => {
    const { container } = shown(UI_EXAMPLE, { streaming: true });
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
    expect(container.textContent).not.toContain("(1, 1)");
  });
});

describe("the turn a form sends", () => {
  it("renders compactly: a chip, its table, and no trailer", () => {
    const client = new QueryClient();
    const turn = uiTurn(
      "Form knn\n\n| Field | Answer |\n| --- | --- |\n| d1 | 5 ✓ |\n\nScore: 1 / 1",
      {
        block: "knn",
        values: { "knn.d1": "5" },
        graded: { "knn.d1": true },
      },
    );
    const item = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: turn }],
    } as unknown as MessageItem;
    const { container, getByText } = render(
      <QueryClientProvider client={client}>
        <UserMessage item={item} />
      </QueryClientProvider>,
    );
    expect(getByText("Answered a form (knn)")).toBeTruthy();
    expect(container.querySelector("table")?.textContent).toContain("d1");
    expect(container.querySelector("table")?.textContent).toContain("5");
    // The trailer the answers rode in is nowhere on the page.
    expect(container.innerHTML).not.toContain("ui-response");
    expect(container.innerHTML).not.toContain("messageId");
  });
});
