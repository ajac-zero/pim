import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, call } from "./pim-api";

const refuse = (status: number, body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(body, { status })),
  );

afterEach(() => vi.unstubAllGlobals());

describe("what a refused call says", () => {
  it("is the v2 server's message rather than its error code, which stays in the body", async () => {
    refuse(400, { error: "bad_request", message: "commandId is required" });
    const refused = (await call("/x").catch((error) => error)) as ApiError;
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused.message).toBe("commandId is required");
    expect(refused.body).toMatchObject({ error: "bad_request" });
  });

  it("is the Worker's error, which has no message", async () => {
    refuse(400, { error: "Give either at or before: a message's id" });
    await expect(call("/x")).rejects.toThrow(
      "Give either at or before: a message's id",
    );
  });

  it("is the status when the body says nothing", async () => {
    refuse(502, {});
    await expect(call("/x")).rejects.toThrow("Pim answered 502");
  });
});
