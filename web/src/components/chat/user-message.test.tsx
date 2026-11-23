// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UserMessage } from "~/components/chat/items";

afterEach(cleanup);

const item = {
  type: "message",
  role: "user",
  id: "17",
  content: "two",
} as const;

const show = (props: Partial<Parameters<typeof UserMessage>[0]>) =>
  render(<UserMessage item={item} {...props} />);

it("retries from a message once the person agrees that what came after goes", async () => {
  const onRetry = vi.fn().mockResolvedValue(undefined);
  const confirm = vi.fn();
  window.confirm = confirm;
  show({ onRetry });
  const button = screen.getByRole("button", { name: "Retry from here" });
  expect(button.getAttribute("title")).toBe("Retry from here");
  // Declined: nothing is removed.
  confirm.mockReturnValueOnce(false);
  fireEvent.click(button);
  expect(confirm).toHaveBeenCalledWith(
    "Retry from here? Later messages in this chat will be removed.",
  );
  expect(onRetry).not.toHaveBeenCalled();
  confirm.mockReturnValueOnce(true);
  fireEvent.click(button);
  expect(onRetry).toHaveBeenCalledExactlyOnceWith("17");
});

it("sits beside Copy and Edit, and is disabled while the agent is at work", () => {
  show({ onRetry: vi.fn(), onEdit: vi.fn(), busy: true });
  const names = screen
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
  expect(names).toEqual(["Copy message", "Edit message", "Retry from here"]);
  expect(
    (
      screen.getByRole("button", {
        name: "Retry from here",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("has no Retry for a message that cannot be retried", () => {
  show({});
  expect(screen.queryByRole("button", { name: "Retry from here" })).toBeNull();
});
