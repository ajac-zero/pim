import { afterEach, describe, expect, it, vi } from "vitest";
import { auth, freeUsername, usernameFrom } from "./auth";

describe("usernames made from names", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps a name's letters and digits, joined by single hyphens", () => {
    expect(usernameFrom("Grace Hopper")).toBe("grace-hopper");
    expect(usernameFrom("  José-María  O'Brien 3rd ")).toBe(
      "jose-maria-o-brien-3rd",
    );
    expect(usernameFrom("Ærøskøbing Zoë Strauß")).toBe(
      "aeroskobing-zoe-strauss",
    );
    // Cut short without a hyphen left at the end, so a number can follow.
    expect(usernameFrom("Maximiliana Wilhelmina Ann von Habsburg")).toBe(
      "maximiliana-wilhelmina-ann",
    );
    expect(usernameFrom("李小龙 🐉")).toBe("");
  });

  it("numbers a name that's taken, and makes one for a name that gives too little", async () => {
    const taken = new Set(["grace-hopper", "grace-hopper-2"]);
    vi.spyOn(auth, "usernameAvailable").mockImplementation(async (name) => ({
      available: !taken.has(name),
    }));
    expect(await freeUsername("Grace Hopper")).toBe("grace-hopper-3");
    expect(await freeUsername("李小龙")).toMatch(/^person-\d{4}$/);
    expect(await freeUsername("Al")).toMatch(/^al-\d{4}$/);
  });
});
