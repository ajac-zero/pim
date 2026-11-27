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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompactChat } from "~/components/chat/compact-chat";
import { I18nProvider } from "~/components/i18n";
import { ApiError, pim, type Session } from "~/lib/pim-api";
import { sessionContextQuery, sessionsQuery } from "~/lib/queries";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

const KEEP = 20_000;
let client: QueryClient;

function show(session: Partial<Session>) {
  const row = { id: "chat", busy: false, contextTokens: 60_000, ...session };
  client.setQueryData(sessionsQuery().queryKey, [row] as never);
  client.setQueryData(sessionContextQuery("chat", row.contextTokens).queryKey, {
    tokens: row.contextTokens ?? 0,
    window: 200_000,
    compactAt: 180_000,
    keepRecent: KEEP,
    model: "m",
  } as never);
}

/** One update of the chat's sidebar row, as Live sends them: the query's observers are told on the next tick, so each is let through before the next. */
const live = (session: Partial<Session>) =>
  act(async () => {
    show(session);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

const button = () => screen.getByRole("button");

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  show({});
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <CompactChat sessionId="chat" />
      </I18nProvider>
    </QueryClientProvider>,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  toast.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
});

it("is offered when the agent is idle and the context holds more than a compaction keeps", () => {
  expect(button().hasAttribute("disabled")).toBe(false);
  expect(button().getAttribute("aria-label")).toMatch(/^Compact conversation/);
  expect(button().getAttribute("title")).toBe(
    button().getAttribute("aria-label"),
  );
});

it.each([
  ["the agent is working", { busy: true }, /not while the agent is working/],
  [
    "the chat has no answer yet",
    { contextTokens: undefined },
    /nothing to compact/,
  ],
  [
    "the context is no more than a compaction keeps",
    { contextTokens: KEEP },
    /nothing to compact/,
  ],
  [
    "the chat is a visit",
    { visit: { username: "bo", available: true } },
    /someone else's agent/,
  ],
])("is disabled, with the reason, when %s", async (_when, session, reason) => {
  act(() => show(session as Partial<Session>));
  await waitFor(() => expect(button().hasAttribute("disabled")).toBe(true));
  expect(button().getAttribute("aria-label")).toMatch(reason);
});

it("asks for the compaction, shows it under way, and reports the context before and after", async () => {
  const compact = vi
    .spyOn(pim, "compactSession")
    .mockResolvedValue({ session: "chat", commandId: "c", tokens: 60_000 });
  fireEvent.click(button());
  expect(compact).toHaveBeenCalledWith("chat");
  await waitFor(() =>
    expect(button().getAttribute("aria-label")).toBe(
      "Compacting the conversation…",
    ),
  );
  expect(button().hasAttribute("disabled")).toBe(true);
  await live({ compacting: true });
  await live({ compacting: false, contextTokens: 25_000 });
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      "Compacted: the context went from 60,000 to 25,000 tokens.",
    ),
  );
  await waitFor(() => expect(button().hasAttribute("disabled")).toBe(false));
});

it("says so when the compaction found nothing to summarize", async () => {
  vi.spyOn(pim, "compactSession").mockResolvedValue({
    session: "chat",
    commandId: "c",
    tokens: 60_000,
  });
  fireEvent.click(button());
  await live({ compacting: true });
  await live({ compacting: false });
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      "Nothing was compacted: there isn't enough older history.",
    ),
  );
  expect(toast.success).not.toHaveBeenCalled();
});

it("reports the error of a compaction that failed", async () => {
  vi.spyOn(pim, "compactSession").mockResolvedValue({
    session: "chat",
    commandId: "c",
    tokens: 60_000,
  });
  fireEvent.click(button());
  await live({ compacting: true });
  await live({
    compacting: false,
    compactionFailure: { task: 7, error: "the model is down" },
  });
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't compact the conversation: the model is down",
    ),
  );
});

it("shows the server's refusal and is offered again", async () => {
  vi.spyOn(pim, "compactSession").mockRejectedValue(
    new ApiError(
      409,
      "The agent is at work in this chat; compact it when it has finished",
    ),
  );
  fireEvent.click(button());
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "The agent is at work in this chat; compact it when it has finished",
    ),
  );
  expect(button().hasAttribute("disabled")).toBe(false);
});

it("does not take a failure that was already shown for the outcome of this compaction", async () => {
  await live({ compactionFailure: { task: 7, error: "the model is down" } });
  vi.spyOn(pim, "compactSession").mockResolvedValue({
    session: "chat",
    commandId: "c",
    tokens: 60_000,
  });
  fireEvent.click(button());
  await live({
    compacting: true,
    compactionFailure: { task: 7, error: "the model is down" },
  });
  await live({
    compacting: false,
    compactionFailure: { task: 7, error: "the model is down" },
  });
  await waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      "Nothing was compacted: there isn't enough older history.",
    ),
  );
  expect(toast.error).not.toHaveBeenCalled();
});
