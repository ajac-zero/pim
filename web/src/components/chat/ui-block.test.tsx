// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { UserMessage } from "~/components/chat/items";
import { Markdown } from "~/components/chat/markdown";
import { ReplyImages } from "~/components/chat/reply-blocks";
import type { MessageItem } from "~/lib/openresponses";
import { ApiError, pim, type StoredUiState } from "~/lib/pim-api";
import {
  checkUiState,
  compile,
  evaluate,
  initialState,
  MAX_TURN_BYTES,
  type UiResponse,
  uiBlockId,
  uiResponseOf,
  uiTurn,
} from "../../../../src/ui-lang";
import { UI_EXAMPLE } from "../../../../src/ui-lang/catalog";

/** What the block was compiled from, each time, so a test can count compiles. */
const compiled = vi.hoisted(() => [] as { source: string; partial: boolean }[]);
vi.mock("../../../../src/ui-lang", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../../src/ui-lang")>();
  return {
    ...real,
    compile: (source: string, options?: { partial?: boolean }) => {
      compiled.push({ source, partial: options?.partial === true });
      return real.compile(source, options);
    },
  };
});

/** What Pim keeps of the blocks of message m1, as the API would hold it. */
let kept: Record<string, StoredUiState>;
let saveUiState: MockInstance<typeof pim.saveUiState>;

beforeEach(() => {
  kept = {};
  vi.spyOn(pim, "uiStates").mockImplementation(async () =>
    structuredClone(kept),
  );
  saveUiState = vi
    .spyOn(pim, "saveUiState")
    .mockImplementation(async (_message, block, body) => {
      kept[block] = {
        version: body.version + 1,
        state: body.state,
        submitted: body.submitted,
        updatedAt: 0,
      };
      return structuredClone(kept[block] as StoredUiState);
    });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

/** The id Pim keeps the example's state under. */
const BLOCK = uiBlockId(UI_EXAMPLE);

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
    const { container } = shown('<form id="x"><gauge/></form>');
    expect(container.textContent).toContain("Form x");
    expect(container.textContent).toContain("couldn't be shown");
    expect(container.textContent).toContain(
      "<gauge> is not one of the components",
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

  it("sends a slider and a checkbox outside the form with the turn", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    shown(
      [
        "{@state seats = 8}",
        '<slider name="seats" min={1} max={50}/>',
        '<checkbox name="annual"/>',
        '<form id="f" submitLabel="Check and send" onSubmit={[issueNewTurn(formSummary("f"))]}>',
        '  <input name="a" label="A"/>',
        "</form>",
      ].join("\n"),
      { send },
    );
    fireEvent.change(screen.getByRole("slider"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(field("f.a"), { target: { value: "x" } });
    submit();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const turn = send.mock.calls[0]?.[0] ?? "";
    expect(turn).toContain("- seats: 12");
    expect(turn).toContain("- annual: true");
    expect(uiResponseOf(turn)).toMatchObject({
      block: "f",
      values: { "f.a": "x" },
      state: { seats: 12, annual: true },
    });
  });

  it("sends a turn of exactly the most a turn may be, and refuses one byte more", async () => {
    const turnOf = async (padding: number) => {
      cleanup();
      const send = vi.fn().mockResolvedValue(undefined);
      shown(
        `<form id="f" submitLabel="Send" onSubmit={[issueNewTurn("${"a".repeat(padding)}")]}><input name="a"/></form>`,
        { send },
      );
      fireEvent.change(field("f.a"), { target: { value: "x" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      return send;
    };
    // What a turn is besides its padding, measured from one with none.
    const bare = await turnOf(0);
    await waitFor(() => expect(bare).toHaveBeenCalledTimes(1));
    const overhead = new TextEncoder().encode(bare.mock.calls[0]?.[0]).length;
    const at = await turnOf(MAX_TURN_BYTES - overhead);
    await waitFor(() => expect(at).toHaveBeenCalledTimes(1));
    expect(new TextEncoder().encode(at.mock.calls[0]?.[0]).length).toBe(
      MAX_TURN_BYTES,
    );
    const over = await turnOf(MAX_TURN_BYTES - overhead + 1);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("too long to send");
    expect(over).not.toHaveBeenCalled();
    // The form is open again, to be answered shorter.
    expect(field("f.a").disabled).toBe(false);
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

  it("shows a placeholder until a block still being written has something to draw", () => {
    const { container } = render(
      <ReplyImages images={{}} streaming>
        <Markdown text={"```ui\n<for"} streaming />
      </ReplyImages>,
    );
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

describe("what a ui block holds, kept by Pim", () => {
  it("draws a draft again after the block is shown anew, from what Pim kept", async () => {
    const first = shown(UI_EXAMPLE, { send: vi.fn() });
    fireEvent.change(field("knn.d1"), { target: { value: "5" } });
    fireEvent.change(field("knn.pred"), { target: { value: "B" } });
    // Leaving the chat saves the last change without waiting for a pause.
    first.unmount();
    await waitFor(() => expect(saveUiState).toHaveBeenCalledTimes(1));
    expect(kept[BLOCK]?.state.values).toMatchObject({
      "knn.d1": "5",
      "knn.pred": "B",
    });
    shown(UI_EXAMPLE, { send: vi.fn() });
    await waitFor(() => expect(field("knn.d1").value).toBe("5"));
    expect(field("knn.pred").value).toBe("B");
    // A draft isn't a submission: still open to change.
    expect(field("knn.d1").disabled).toBe(false);
  });

  it("keeps what the person typed over what Pim answers late with", async () => {
    kept[BLOCK] = {
      version: 3,
      state: { values: { "knn.d1": "9" }, revealed: {}, submitted: {} },
      submitted: false,
      updatedAt: 0,
    };
    shown(UI_EXAMPLE, { send: vi.fn() });
    fireEvent.change(field("knn.d1"), { target: { value: "5" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(field("knn.d1").value).toBe("5");
  });

  it("saves once after a pause, whatever was typed in between", async () => {
    vi.useFakeTimers();
    shown(UI_EXAMPLE, { send: vi.fn() });
    for (const value of ["1", "12", "123"]) {
      fireEvent.change(field("knn.d1"), { target: { value } });
      await vi.advanceTimersByTimeAsync(200);
    }
    // 200 ms after the last change, 600 after the first: nothing yet.
    expect(saveUiState).not.toHaveBeenCalled();
    // Typing wasn't blocked: the field holds what was typed.
    expect(field("knn.d1").value).toBe("123");
    await vi.advanceTimersByTimeAsync(300);
    expect(saveUiState).toHaveBeenCalledTimes(1);
    expect(saveUiState).toHaveBeenCalledWith("m1", BLOCK, {
      version: 0,
      state: expect.objectContaining({
        values: expect.objectContaining({ "knn.d1": "123" }),
      }),
      submitted: false,
    });
  });

  it("tries a write that failed again, slower each time, then goes on from the version it holds", async () => {
    vi.useFakeTimers();
    saveUiState
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new ApiError(502, "bad gateway"));
    shown(UI_EXAMPLE, { send: vi.fn() });
    fireEvent.change(field("knn.d1"), { target: { value: "5" } });
    await vi.advanceTimersByTimeAsync(500);
    expect(saveUiState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(saveUiState).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(saveUiState).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(saveUiState).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(saveUiState).toHaveBeenCalledTimes(3);
    // Every try carried the same state, over the version Pim never confirmed.
    const tries = saveUiState.mock.calls.map(([, , body]) => body);
    expect(new Set(tries.map((body) => JSON.stringify(body))).size).toBe(1);
    expect(tries[0]?.version).toBe(0);
    expect(kept[BLOCK]?.state.values?.["knn.d1"]).toBe("5");
    // Saved: nothing more is sent.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(saveUiState).toHaveBeenCalledTimes(3);
  });

  it("locks a form from what Pim kept as submitted, with no trailer in the chat", async () => {
    const program = compile(UI_EXAMPLE);
    let state = initialState(program);
    for (const [key, value] of [
      ["knn.d1", "5"],
      ["knn.d2", "13"],
      ["knn.pred", "A"],
    ] as const)
      state = evaluate(program, state, { type: "change", key, value }).state;
    state = evaluate(program, state, { type: "submit", form: "knn" }).state;
    kept[BLOCK] = { version: 4, state, submitted: true, updatedAt: 0 };
    const send = vi.fn();
    shown(UI_EXAMPLE, { send });
    await waitFor(() => expect(field("knn.d1").disabled).toBe(true));
    expect(field("knn.d1").value).toBe("5");
    expect(screen.getByText(/Score: 3 \/ 3/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
    expect(saveUiState).not.toHaveBeenCalled();
  });

  it("marks the block submitted once its turn was sent, and not before", async () => {
    let placed = () => {};
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          placed = resolve;
        }),
    );
    shown(UI_EXAMPLE, { send });
    fireEvent.change(field("knn.d1"), { target: { value: "5" } });
    fireEvent.change(field("knn.d2"), { target: { value: "7" } });
    fireEvent.change(field("knn.pred"), { target: { value: "B" } });
    submit();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    // Locked here, but the turn isn't placed: Pim holds it as an answer still open.
    expect(saveUiState.mock.calls.every(([, , body]) => !body.submitted)).toBe(
      true,
    );
    placed();
    await waitFor(() =>
      expect(saveUiState.mock.lastCall?.[2]).toMatchObject({
        submitted: true,
        state: { submitted: { knn: expect.anything() } },
      }),
    );
    expect(kept[BLOCK]?.submitted).toBe(true);
  });

  it("doesn't mark it submitted when the turn failed to send, and lets the form be answered again", async () => {
    shown(UI_EXAMPLE, {
      send: vi.fn().mockRejectedValue(new Error("offline")),
    });
    fireEvent.change(field("knn.d1"), { target: { value: "5" } });
    fireEvent.change(field("knn.d2"), { target: { value: "7" } });
    fireEvent.change(field("knn.pred"), { target: { value: "B" } });
    submit();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    await waitFor(() => expect(kept[BLOCK]?.state.submitted).toEqual({}));
    expect(kept[BLOCK]?.submitted).toBe(false);
  });

  it("stops writing and locks what a stale write finds submitted elsewhere", async () => {
    const program = compile(UI_EXAMPLE);
    const filled = initialState(program);
    Object.assign(filled.values, { "knn.d1": 5, "knn.d2": 7, "knn.pred": "B" });
    const answered = evaluate(program, filled, {
      type: "submit",
      form: "knn",
    }).state;
    saveUiState.mockRejectedValueOnce(
      new ApiError(409, "submitted", {
        current: { version: 7, state: answered, submitted: true, updatedAt: 0 },
      }),
    );
    shown(UI_EXAMPLE, { send: vi.fn() });
    fireEvent.change(field("knn.d1"), { target: { value: "9" } });
    fireEvent.change(field("knn.d2"), { target: { value: "7" } });
    fireEvent.change(field("knn.pred"), { target: { value: "B" } });
    await waitFor(() => expect(field("knn.d1").disabled).toBe(true), {
      timeout: 2000,
    });
    expect(saveUiState).toHaveBeenCalledTimes(1);
  });

  it("keeps nothing for a copy that can't send turns", async () => {
    shown(UI_EXAMPLE);
    fireEvent.change(field("knn.d1"), { target: { value: "5" } });
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(pim.uiStates).not.toHaveBeenCalled();
    expect(saveUiState).not.toHaveBeenCalled();
  });

  it("goes over a block saved from elsewhere since, the last writer winning", async () => {
    vi.useFakeTimers();
    saveUiState.mockRejectedValueOnce(
      new ApiError(409, "saved since", {
        current: {
          version: 5,
          state: { values: {}, revealed: {}, submitted: {} },
          submitted: false,
          updatedAt: 0,
        },
      }),
    );
    shown(UI_EXAMPLE, { send: vi.fn() });
    fireEvent.change(field("knn.d1"), { target: { value: "5" } });
    await vi.advanceTimersByTimeAsync(500);
    expect(saveUiState).toHaveBeenCalledTimes(2);
    expect(saveUiState.mock.calls.map(([, , body]) => body.version)).toEqual([
      0, 5,
    ]);
    expect(kept[BLOCK]?.state.values?.["knn.d1"]).toBe("5");
  });
});

/** A slider-driven price calculator, which the docs show. */
const CALCULATOR = [
  "{@state seats = 8}",
  '<slider name="seats" label="Seats" min={1} max={50} unit="seats"/>',
  "{@let price = seats * 29}",
  "<text>{seats} seats cost \u0024{price} a month</text>",
].join("\n");

const slider = (name: string) =>
  document.querySelector<HTMLInputElement>(
    `[data-field="${name}"] input`,
  ) as HTMLInputElement;

describe("a checkbox, slider and chart in a reply", () => {
  it("recalculates a derived value as the slider moves", () => {
    const { container } = shown(CALCULATOR, { send: vi.fn() });
    expect(container.textContent).toContain("8 seats cost $232 a month");
    expect(slider("seats").value).toBe("8");
    expect(container.querySelector("output")?.textContent).toBe("8 seats");
    fireEvent.change(slider("seats"), { target: { value: "20" } });
    expect(container.textContent).toContain("20 seats cost $580 a month");
    expect(container.querySelector("output")?.textContent).toBe("20 seats");
    expect(slider("seats").value).toBe("20");
  });

  it("recalculates from a checkbox as it is ticked", () => {
    const { container } = shown(
      [
        '<checkbox name="vat" label="Add VAT"/>',
        "{@let total = vat ? 120 : 100}",
        "<text>Total {total}</text>",
      ].join("\n"),
      { send: vi.fn() },
    );
    expect(container.textContent).toContain("Total 100");
    fireEvent.click(screen.getByLabelText("Add VAT"));
    expect(container.textContent).toContain("Total 120");
    expect((screen.getByLabelText("Add VAT") as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByLabelText("Add VAT"));
    expect(container.textContent).toContain("Total 100");
  });

  it("draws a chart from state and draws it again when the slider moves", () => {
    const { container } = shown(
      [
        "{@state seats = 2}",
        '<slider name="seats" label="Seats" min={1} max={10}/>',
        "{@let rows = [{plan: 'Solo', cost: seats * 10}, {plan: 'Team', cost: seats * 25}]}",
        '<chart kind="bar" title="Monthly cost" data={rows} x="plan" y="cost"/>',
        '<badge tone="warn">Estimate</badge>',
      ].join("\n"),
      { send: vi.fn() },
    );
    const cells = () =>
      [...container.querySelectorAll("figure tbody td")].map(
        (cell) => cell.textContent,
      );
    expect(cells()).toEqual(["Solo", "20", "Team", "50"]);
    expect(container.querySelector("figure")?.getAttribute("data-chart")).toBe(
      "bar",
    );
    expect(
      container.querySelector('[role="img"]')?.getAttribute("aria-label"),
    ).toBe("Monthly cost");
    expect(
      [...container.querySelectorAll("figure th")].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["plan", "cost"]);
    fireEvent.change(slider("seats"), { target: { value: "4" } });
    expect(cells()).toEqual(["Solo", "40", "Team", "100"]);
    expect(container.querySelector('[data-tone="warn"]')?.textContent).toBe(
      "Estimate",
    );
  });

  it("keeps a slider's and a checkbox's state outside a form through Pim's writer, in a shape Pim accepts", async () => {
    vi.useFakeTimers();
    const source = `${CALCULATOR}\n<checkbox name="vat" label="Add VAT"/>`;
    shown(source, { send: vi.fn() });
    fireEvent.change(slider("seats"), { target: { value: "30" } });
    fireEvent.click(screen.getByLabelText("Add VAT"));
    await vi.advanceTimersByTimeAsync(500);
    const id = uiBlockId(source);
    expect(saveUiState).toHaveBeenCalledTimes(1);
    expect(saveUiState).toHaveBeenCalledWith("m1", id, {
      version: 0,
      state: expect.objectContaining({
        values: expect.objectContaining({ seats: 30, vat: true }),
      }),
      submitted: false,
    });
    const body = saveUiState.mock.calls[0]?.[2];
    expect(checkUiState(compile(source), body?.state).ok).toBe(true);
  });

  it("draws a block again as Pim kept it", async () => {
    const source = CALCULATOR;
    kept[uiBlockId(source)] = {
      version: 3,
      state: { values: { seats: 40 }, revealed: {}, submitted: {} },
      submitted: false,
      updatedAt: 0,
    };
    const { container } = shown(source, { send: vi.fn() });
    await waitFor(() =>
      expect(container.textContent).toContain("40 seats cost $1160 a month"),
    );
    expect(slider("seats").value).toBe("40");
  });

  it("checks a form's checkbox and slider when it is submitted", () => {
    const send = vi.fn().mockResolvedValue(undefined);
    shown(
      '<form id="f" onSubmit={[reveal(), issueNewTurn(formSummary("f"))]}><checkbox name="ok" label="Sure" answer={true} required={true}/><slider name="n" label="Pick" min={0} max={10} answer={4}/></form>',
      { send },
    );
    const submitButton = () =>
      screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Sure"));
    fireEvent.change(slider("f.n"), { target: { value: "7" } });
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    expect(screen.getByText("Expected 4")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Wrong" })).toHaveLength(1);
    expect(screen.getAllByRole("img", { name: "Correct" })).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("falls back to Markdown with the new components in it", () => {
    const { container } = shown("<badge>Hi</badge><gauge/>");
    expect(container.textContent).toContain("couldn't be shown");
    cleanup();
    const source = [
      '<badge tone="good">Paid</badge>',
      '<checkbox name="a" label="Receipt"/>',
      '<slider name="s" label="Seats" min={0} max={9} value={3} unit="seats"/>',
      '<chart kind="line" data={[1, 2]}/>',
      "<gauge/>",
    ].join("\n");
    const view = shown(source);
    expect(view.container.textContent).toContain("Paid");
    expect(view.container.textContent).toContain("Receipt");
    expect(view.container.textContent).toContain("Seats: 3 seats");
    expect(view.container.querySelectorAll("table")).toHaveLength(1);
  });
});

describe("a ui block while its message streams", () => {
  const send = vi.fn(async (_text: string) => {});
  const client = new QueryClient();
  const fence = (source: string) => `Here you go:\n\n\`\`\`ui\n${source}`;
  const view = (text: string, streaming: boolean) => (
    <QueryClientProvider client={client}>
      <ReplyImages images={{}} streaming={streaming} send={send} messageId="m1">
        <Markdown text={text} streaming={streaming} />
      </ReplyImages>
    </QueryClientProvider>
  );
  const fields = () => document.querySelectorAll("[data-field]").length;
  const submitButton = () =>
    document.querySelector<HTMLButtonElement>('[data-part="submit"]');

  /** Tokens of a few characters, arriving every 20 ms, as `render` shows them. */
  async function stream(
    source: string,
    from: number,
    to: number,
    each: (end: number) => void,
    rerender: (ui: ReactElement) => void,
  ) {
    for (let end = from; end <= to; end += 3) {
      rerender(view(fence(source.slice(0, end)), true));
      await act(async () => {
        vi.advanceTimersByTime(20);
      });
      each(end);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    compiled.length = 0;
    send.mockClear();
  });

  it("shows each component once its tag is complete, never throws, and compiles far less often than tokens arrive", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { rerender, container } = render(view(fence(""), true));
    const seen: number[] = [];
    await stream(
      UI_EXAMPLE,
      0,
      UI_EXAMPLE.length,
      () => {
        seen.push(fields());
        // What the repair cut is for whoever debugs, not for the person.
        expect(container.textContent).not.toMatch(/unterminated|<number|<row/);
      },
      rerender,
    );
    // Components arrive one after another, never leaving once there.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen)).toEqual(new Set([0, 1, 2, 3]));
    const tokens = Math.ceil(UI_EXAMPLE.length / 3);
    const partials = compiled.filter((entry) => entry.partial).length;
    expect(partials).toBeGreaterThan(5);
    expect(partials).toBeLessThan(tokens / 4);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("repaired"),
      expect.anything(),
    );
    // The stream ends: one more compile, of the whole block.
    rerender(view(`${fence(UI_EXAMPLE)}\n\`\`\``, false));
    expect(compiled.at(-1)).toEqual({ source: UI_EXAMPLE, partial: false });
    expect(fields()).toBe(3);
  });

  it("keeps a value typed mid-stream through later compiles and the end, and saves it under the final id", async () => {
    const { rerender } = render(view(fence(""), true));
    let typed = false;
    await stream(
      UI_EXAMPLE,
      0,
      UI_EXAMPLE.length,
      () => {
        if (!typed && fields() >= 1) {
          typed = true;
          fireEvent.change(field("knn.d1"), { target: { value: "5" } });
        }
        if (typed) expect(field("knn.d1").value).toBe("5");
      },
      rerender,
    );
    expect(typed).toBe(true);
    // Nothing is written under the ids of cuts of the block.
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(saveUiState).not.toHaveBeenCalled();
    rerender(view(`${fence(UI_EXAMPLE)}\n\`\`\``, false));
    expect(field("knn.d1").value).toBe("5");
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(saveUiState).toHaveBeenCalledTimes(1);
    expect(saveUiState.mock.calls[0]?.[1]).toBe(BLOCK);
    expect(kept[BLOCK]?.state?.values?.["knn.d1"]).toBe("5");
  });

  it("keeps submit disabled until the stream completes", async () => {
    const { rerender } = render(view(fence(""), true));
    const upTo = UI_EXAMPLE.indexOf("</form>");
    await stream(UI_EXAMPLE, 0, upTo, () => {}, rerender);
    // Every field is there and can be filled in; nothing can be sent.
    fillAll();
    expect(field("knn.d1").value).toBe("5");
    expect(submitButton()?.disabled).toBe(true);
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    submitButton()?.click();
    expect(send).not.toHaveBeenCalled();
    rerender(view(`${fence(UI_EXAMPLE)}\n\`\`\``, false));
    expect(submitButton()?.disabled).toBe(false);
    submit();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good render when a newer compile fails", async () => {
    const { rerender, container } = render(view(fence(""), true));
    const good = "<text>Hello there</text>\n";
    const steps = [good, `${good}<bogus/>\n<text>More</text>\n`];
    for (const source of steps) {
      rerender(view(fence(source), true));
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
    }
    // The second compile failed (an unknown tag); the first stands, with no fallback or placeholder.
    expect(container.textContent).toContain("Hello there");
    expect(container.textContent).not.toContain("More");
    expect(container.querySelector(".animate-pulse")).toBeNull();
    expect(container.textContent).not.toContain("couldn't be shown");
  });
});
