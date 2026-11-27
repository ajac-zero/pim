// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { type ModelInfo, pim } from "~/lib/pim-api";
import { pimClient } from "~/lib/pim-client";
import { useStartChat } from "~/lib/start-chat";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => async () => {},
}));

afterEach(() => vi.restoreAllMocks());

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

function spies() {
  const calls: string[] = [];
  vi.spyOn(pim, "createSession").mockImplementation(async () => {
    calls.push("create");
    return { id: "chat" } as never;
  });
  vi.spyOn(pim, "chooseSessionModel").mockImplementation(async (_, model) => {
    calls.push(`model:${model?.id}`);
    return { model: model as ModelInfo };
  });
  vi.spyOn(pimClient, "open").mockImplementation(() => {});
  vi.spyOn(pimClient, "send").mockImplementation(async () => {
    calls.push("send");
  });
  return calls;
}

it("sets the chosen model on the new chat before its first message goes", async () => {
  const calls = spies();
  const { result } = renderHook(
    () => useStartChat("a", { provider: "own:home", id: "vision" }),
    { wrapper },
  );
  await result.current.start("hello");
  expect(pim.chooseSessionModel).toHaveBeenCalledWith("chat", {
    provider: "own:home",
    id: "vision",
  });
  expect(calls).toEqual(["create", "model:vision", "send"]);
});

it("makes no model request when none was chosen", async () => {
  const calls = spies();
  const { result } = renderHook(() => useStartChat("a", null), { wrapper });
  await result.current.start("hello");
  expect(calls).toEqual(["create", "send"]);
});
