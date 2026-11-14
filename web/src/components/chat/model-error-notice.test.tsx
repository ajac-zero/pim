// @vitest-environment happy-dom

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ModelErrorNotice } from "~/components/chat/thread";
import { modelError } from "~/lib/pim-view";

afterEach(cleanup);

/** NOT_DELIVERED in src/extensions/messaging.ts, which the web app's type check can't import. */
const NOT_DELIVERED = "The agent did not deliver its reply with send_to_user.";

it("tells a room's group chat that an agent sent no reply, and lets the person try again", async () => {
  const error = modelError(NOT_DELIVERED);
  expect(error.problem).toBe("undelivered");
  const onRetry = vi.fn();
  const root = createRootRoute({
    component: () => (
      <ModelErrorNotice
        name="Coach"
        error={error}
        held
        retrying={false}
        onRetry={onRetry}
      />
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/" }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  expect(await screen.findByText("Coach")).toBeTruthy();
  expect(
    screen.getByText(
      "The agent ended its turn without sending a reply. Try again.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});
