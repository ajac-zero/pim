// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConflictBanner, FileView } from "~/components/file-view";
import { type FileClient, FileSession } from "~/lib/file-session";
import { MAX_EDITABLE_BYTES, MAX_VIEWABLE_BYTES } from "~/lib/file-text";
import { FileConflictError } from "~/lib/pim-api";
import { filesQuery } from "~/lib/queries";
import { useFileSession } from "~/lib/use-file-session";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
// A plain textarea stands in for CodeMirror, which needs a real layout engine.
vi.mock("~/components/file-editor", () => ({
  default: ({ session }: { session: FileSession }) => (
    <textarea
      aria-label="source"
      defaultValue={session.text}
      onChange={(event) => session.edit(event.target.value)}
    />
  ),
}));

const read = vi.fn();
vi.mock("~/lib/pim-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/pim-api")>()),
  readFile: (...args: unknown[]) => read(...args),
}));

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  read.mockReset();
});

const bytes = (size: number, fill = 65) => new Uint8Array(size).fill(fill);

it("opens up to 1 MiB for editing, up to 5 MiB read-only, and refuses larger or binary files", async () => {
  const phases: Record<string, string> = {};
  for (const [label, file] of [
    ["editable", bytes(MAX_EDITABLE_BYTES)],
    ["readonly", bytes(MAX_EDITABLE_BYTES + 1)],
    ["edge", bytes(MAX_VIEWABLE_BYTES)],
    ["huge", bytes(MAX_VIEWABLE_BYTES + 1)],
    ["binary", new Uint8Array([1, 0, 2])],
  ] as const) {
    read.mockResolvedValueOnce({ bytes: file, sha256: "h" });
    const { result, unmount } = renderHook(() =>
      useFileSession("/workspace/x", true),
    );
    await waitFor(() => expect(result.current.load.phase).not.toBe("loading"));
    phases[label] =
      result.current.load.phase === "ready"
        ? result.current.state.status
        : result.current.load.phase;
    unmount();
  }
  expect(phases).toEqual({
    editable: "clean",
    readonly: "readonly",
    edge: "readonly",
    huge: "refused",
    binary: "refused",
  });
});

it("leaves no timers running after the tab unmounts, and saves what is pending", async () => {
  vi.useFakeTimers();
  read.mockResolvedValueOnce({ bytes: bytes(3), sha256: "h" });
  const { result, unmount } = renderHook(() =>
    useFileSession("/workspace/x", true),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const load = result.current.load;
  if (load.phase !== "ready") throw new Error("not ready");
  const put = vi.fn(() => new Promise<never>(() => {}));
  vi.stubGlobal("fetch", put);
  load.session.edit("changed");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(put).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("resolves a conflict through its two buttons with the right requests", async () => {
  const conflict = new FileConflictError("hash_mismatch", "theirs", 1, 1);
  const client: FileClient = {
    readFile: vi.fn(async () => ({
      bytes: new TextEncoder().encode("disk"),
      sha256: "d",
    })),
    writeFile: vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue({ path: "p", sha256: "n", size: 1, mtime: 1 }),
  };
  const session = new FileSession("/workspace/a.txt", client);
  session.open({ bytes: new TextEncoder().encode("one"), sha256: "h0" }, false);
  session.edit("mine");
  await session.flush();
  render(<ConflictBanner session={session} />);
  fireEvent.click(screen.getByRole("button", { name: "Overwrite with mine" }));
  await waitFor(() => expect(session.getState().status).toBe("saved"));
  expect(client.writeFile).toHaveBeenLastCalledWith(
    "/workspace/a.txt",
    "mine",
    { ifMatch: "theirs" },
  );

  const again = new FileSession("/workspace/a.txt", client);
  again.open({ bytes: new TextEncoder().encode("one"), sha256: "h0" }, false);
  (client.writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
    conflict,
  );
  again.edit("mine");
  await again.flush();
  cleanup();
  render(<ConflictBanner session={again} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Reload from disk (discard my edits)" }),
  );
  await waitFor(() => expect(again.getState().status).toBe("clean"));
  expect(client.readFile).toHaveBeenCalledTimes(1);
  expect(again.text).toBe("disk");
  void act;
});

it("opens markdown rendered, and keeps the unsaved buffer when toggling to the editor and back", async () => {
  read.mockResolvedValue({
    bytes: new TextEncoder().encode("# Title\n"),
    sha256: "h",
  });
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity } },
  });
  client.setQueryData(filesQuery("/workspace").queryKey, {
    path: "/workspace",
    entries: [
      {
        name: "n.md",
        path: "/workspace/n.md",
        type: "file",
        size: 8,
        updatedAt: "",
      },
    ],
  });
  render(
    <QueryClientProvider client={client}>
      <FileView path="/workspace/n.md" />
    </QueryClientProvider>,
  );
  expect((await screen.findByRole("heading", { name: "Title" })).tagName).toBe(
    "H1",
  );
  expect(screen.queryByLabelText("source")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const source = await screen.findByLabelText("source");
  fireEvent.change(source, { target: { value: "# Changed\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(
    (await screen.findByRole("heading", { name: "Changed" })).tagName,
  ).toBe("H1");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(
    ((await screen.findByLabelText("source")) as HTMLTextAreaElement).value,
  ).toBe("# Changed\n");
});
