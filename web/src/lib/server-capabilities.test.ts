import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onServerGeneration,
  probeServer,
  resetServerGeneration,
  serverGeneration,
} from "~/lib/server-capabilities";

afterEach(resetServerGeneration);

const answer = (status: number, body: unknown, type: ResponseType = "basic") =>
  vi.fn(async () => ({ status, type, json: async () => body }) as Response);

describe("which Pim answers", () => {
  it("is v2 when the sidebar's snapshot is served, and tells those who asked", async () => {
    const changed = vi.fn();
    onServerGeneration(changed);
    const fetchImpl = answer(200, {
      sessions: [],
      coding: [],
      nextAfter: null,
      liveCursor: null,
    });
    expect(await probeServer(fetchImpl as never)).toBe("v2");
    expect(serverGeneration()).toBe("v2");
    expect(changed).toHaveBeenCalledTimes(1);
    // Asked once.
    await probeServer(fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is v1 for anything else: not found, a page of the app, a body that is not a snapshot", async () => {
    for (const fetchImpl of [
      answer(404, { error: "no" }),
      answer(200, "<html>"),
      answer(200, { sessions: [] }),
    ]) {
      resetServerGeneration();
      expect(await probeServer(fetchImpl as never)).toBe("v1");
    }
  });

  it("decides nothing while signed out or offline, and asks again later", async () => {
    expect(await probeServer(answer(401, null) as never)).toBe("unknown");
    expect(await probeServer(answer(0, null, "opaqueredirect") as never)).toBe(
      "unknown",
    );
    expect(
      await probeServer(
        vi.fn().mockRejectedValue(new Error("offline")) as never,
      ),
    ).toBe("unknown");
    expect(
      await probeServer(
        answer(200, { sessions: [], liveCursor: "x" }) as never,
      ),
    ).toBe("v2");
  });
});
