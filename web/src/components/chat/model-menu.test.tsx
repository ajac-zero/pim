// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useDraftModel, useSessionModel } from "~/components/chat/model-menu";
import { type ModelInfo, pim } from "~/lib/pim-api";
import { agentsQuery, modelQuery, sessionsQuery } from "~/lib/queries";

const model = (id: string) =>
  ({ provider: "own:home", id, name: id, images: false }) as ModelInfo;
const [base, vision, own] = [model("base"), model("vision"), model("own")];

/** A chat with a host and one more agent, each on a model, with the agent `p_buddy` pinned to `vision` for all its chats. */
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(modelQuery().queryKey, {
    model: base,
    choices: [base, vision, own],
    providers: [],
  } as never);
  client.setQueryData(agentsQuery().queryKey, [
    { id: "p_host", name: "Host", model: null },
    {
      id: "p_buddy",
      name: "Buddy",
      model: { provider: "own:home", id: "vision" },
    },
  ] as never);
  client.setQueryData(sessionsQuery().queryKey, [
    {
      id: "chat",
      model: { model: own, override: true },
      room: {
        mode: "mentions",
        members: [{ id: "p_buddy", model: { model: vision, override: false } }],
      },
    },
  ] as never);
  // A choice refreshes the chat list, which here is the list the test began with.
  const list = client.getQueryData(sessionsQuery().queryKey);
  vi.spyOn(pim, "sessions").mockResolvedValue(list as never);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return wrapper;
}

afterEach(() => vi.restoreAllMocks());

it("shows the chat's own model with its agent's as the one to go back to, and chooses for the chat alone", async () => {
  const chat = vi
    .spyOn(pim, "chooseSessionModel")
    .mockResolvedValue({ model: vision });
  const member = vi.spyOn(pim, "chooseRoomMemberModel");
  const agent = vi.spyOn(pim, "chooseAgentModel");
  const { result } = renderHook(() => useSessionModel("chat", "p_host"), {
    wrapper: setup(),
  });
  expect(result.current.current).toEqual(own);
  expect(result.current.pinned).toBe(true);
  expect(result.current.fallback).toEqual(base);
  act(() => result.current.choose.mutate(vision));
  await waitFor(() => expect(chat).toHaveBeenCalledWith("chat", vision));
  act(() => result.current.choose.mutate(null));
  await waitFor(() => expect(chat).toHaveBeenLastCalledWith("chat", null));
  expect(member).not.toHaveBeenCalled();
  expect(agent).not.toHaveBeenCalled();
});

it("chooses another agent's model in a group chat for that chat's seat, never for the agent", async () => {
  const member = vi
    .spyOn(pim, "chooseRoomMemberModel")
    .mockResolvedValue({ model: own });
  const chat = vi.spyOn(pim, "chooseSessionModel");
  const agent = vi.spyOn(pim, "chooseAgentModel");
  const { result } = renderHook(
    () => useSessionModel("chat", "p_buddy", true),
    { wrapper: setup() },
  );
  expect(result.current.current).toEqual(vision);
  expect(result.current.pinned).toBe(false);
  act(() => result.current.choose.mutate(own));
  await waitFor(() =>
    expect(member).toHaveBeenCalledWith("chat", "p_buddy", own),
  );
  expect(chat).not.toHaveBeenCalled();
  expect(agent).not.toHaveBeenCalled();
});

it("drafts a new chat's model: the agent's own to start with, kept across agents, dropped once no longer offered", async () => {
  const wrapper = setup();
  const chat = vi.spyOn(pim, "chooseSessionModel");
  const { result, rerender } = renderHook(({ agent }) => useDraftModel(agent), {
    wrapper,
    initialProps: { agent: "p_buddy" },
  });
  // Nothing chosen: the agent's model, which "Default" goes back to.
  expect(result.current.current).toEqual(vision);
  expect(result.current.fallback).toEqual(vision);
  expect(result.current.pinned).toBe(false);
  expect(result.current.model).toBeNull();
  act(() => result.current.choose.mutate(own));
  expect(result.current.current).toEqual(own);
  expect(result.current.pinned).toBe(true);
  expect(result.current.model).toEqual({ provider: own.provider, id: own.id });
  // Another agent keeps the choice and has its own default.
  rerender({ agent: "p_host" });
  expect(result.current.current).toEqual(own);
  expect(result.current.fallback).toEqual(base);
  act(() => result.current.choose.mutate(null));
  expect(result.current.current).toEqual(base);
  expect(result.current.model).toBeNull();
  expect(chat).not.toHaveBeenCalled();
});

it("drops a drafted model that is no longer one of the choices", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const settings = { model: base, choices: [base, vision], providers: [] };
  client.setQueryData(modelQuery().queryKey, settings as never);
  client.setQueryData(agentsQuery().queryKey, [
    { id: "a", model: null },
  ] as never);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useDraftModel("a"), { wrapper });
  act(() => result.current.choose.mutate(vision));
  expect(result.current.model).toEqual({
    provider: vision.provider,
    id: vision.id,
  });
  act(() =>
    client.setQueryData(modelQuery().queryKey, {
      ...settings,
      choices: [base],
    } as never),
  );
  await waitFor(() => expect(result.current.model).toBeNull());
  expect(result.current.current).toEqual(base);
});
