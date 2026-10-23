import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { CuaControls, openViewer } from "~/components/cua-evaluation";
import type { CuaStatus } from "~/lib/pim-api";

type Offered = Extract<CuaStatus, { offered: true }>;
const status = (mode: Offered["mode"], pending = 0): Offered => ({
  offered: true,
  enabled: true,
  mode,
  generation: 3,
  pending,
  host: "cua-eval.ajac-zero.com",
});

function render(state: Offered): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <CuaControls status={state} />
    </QueryClientProvider>,
  );
}

/** Each button's label, and whether it's disabled. */
const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(
    ([, attributes, inner]) => ({
      label: inner?.replace(/<[^>]+>/g, ""),
      disabled: / disabled=""/.test(attributes ?? ""),
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

it("offers the viewer and resuming only once the pause is complete, and resuming only by hand", () => {
  expect(buttons(render(status("agents")))).toEqual([
    { label: "Pause agents", disabled: false },
  ]);
  const pausing = render(status("pausing", 2));
  expect(pausing).toContain("running on the computer (2)");
  expect(buttons(pausing)).toEqual([
    { label: "Open viewer", disabled: true },
    { label: "Resume agents", disabled: true },
  ]);
  const paused = render(status("paused"));
  expect(buttons(paused)).toEqual([
    { label: "Open viewer", disabled: false },
    { label: "Resume agents", disabled: false },
  ]);
  expect(paused).toContain(
    "Closing it doesn&#x27;t resume your agents; resuming them closes it first",
  );
  // The viewer is never framed here.
  for (const html of [pausing, paused]) expect(html).not.toContain("<iframe");
});

it("opens the viewer in a new tab cut off from the app, and keeps its link nowhere", async () => {
  const url = `https://cua-eval.ajac-zero.com/viewer/#ticket=${"V".repeat(32)}`;
  const tab = {
    opener: {} as unknown,
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
  const open = vi.fn(() => tab);
  const fetch = vi.fn(async () =>
    Response.json({ url, expiresAt: 1_793_000_000_000 }),
  );
  const storage = {
    setItem: () => {
      throw new Error("The viewer's link is kept nowhere");
    },
  };
  vi.stubGlobal("window", {
    open,
    localStorage: storage,
    sessionStorage: storage,
  });
  vi.stubGlobal("fetch", fetch);

  await openViewer();
  expect(open).toHaveBeenCalledWith("", "_blank");
  expect(tab.opener).toBeNull();
  expect(tab.location.replace).toHaveBeenCalledWith(url);
  expect(fetch).toHaveBeenCalledWith(
    "/api/cua/viewer",
    expect.objectContaining({ method: "POST", cache: "no-store" }),
  );

  // Refused, the tab it opened closes again, and nothing is shown.
  const refused = { ...tab, location: { replace: vi.fn() }, close: vi.fn() };
  open.mockReturnValue(refused);
  fetch.mockResolvedValue(
    Response.json(
      { error: "Pause the agents before opening the viewer." },
      { status: 409 },
    ),
  );
  await expect(openViewer()).rejects.toThrow("Pause the agents");
  expect(refused.close).toHaveBeenCalled();
  expect(refused.location.replace).not.toHaveBeenCalled();
});
