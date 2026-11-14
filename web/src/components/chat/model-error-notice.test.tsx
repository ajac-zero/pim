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
/** The start of OUT_OF_OUTPUT_TOKENS's error in the same file, with the limit it adds. */
const OUT_OF_OUTPUT =
  "The model ran out of output tokens before finishing, twice (limit 4500). Ask for something smaller.";

it.each([
  [
    NOT_DELIVERED,
    "undelivered",
    "The agent ended its turn without sending a reply. Try again.",
  ],
  [
    OUT_OF_OUTPUT,
    "out_of_output",
    /^The model ran out of output tokens before it finished, twice\./,
  ],
] as const)(
  "tells a room's group chat why an agent sent no reply (%#), and lets the person try again",
  async (text, problem, message) => {
    const error = modelError(text);
    expect(error.problem).toBe(problem);
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
    expect(screen.getByText(message)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  },
);
