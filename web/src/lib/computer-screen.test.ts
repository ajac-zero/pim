import { describe, expect, it } from "vitest";
import {
  contained,
  h264Codec,
  keyEvent,
  normalized,
  readPacket,
  screenPath,
} from "~/lib/computer-screen";

/** A packet as cua-spacesd sends one: two big-endian lengths, a JSON header and the payload. */
function packet(header: unknown, payload: number[]): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(8 + json.length + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, json.length);
  view.setUint32(4, payload.length);
  bytes.set(json, 8);
  bytes.set(payload, 8 + json.length);
  return bytes.buffer;
}

const keys = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };

describe("the computer's screen", () => {
  it("reads video packets, and leaves out audio and packets cut short", () => {
    const frame = { sequence: 4, keyframe: true, width_px: 1280 };
    const read = readPacket(
      packet({ direction: "video", message: frame }, [9, 8, 7]),
    );
    expect(read?.frame).toEqual(frame);
    expect([...(read?.payload ?? [])]).toEqual([9, 8, 7]);
    expect(
      readPacket(packet({ direction: "audio", message: {} }, [1])),
    ).toBeNull();
    expect(
      readPacket(
        packet({ direction: "video", message: frame }, [9, 8, 7]).slice(0, -1),
      ),
    ).toBeNull();
  });

  it("names the H.264 codec from the sequence parameter set, after whatever comes before it", () => {
    // An access unit delimiter with a four-byte start code, then the SPS (High, level 3.1) with a three-byte one.
    expect(
      h264Codec(new Uint8Array([0, 0, 0, 1, 9, 240, 0, 0, 1, 103, 100, 0, 31])),
    ).toBe("avc1.64001F");
    // Constrained baseline, level 4.2, with a four-byte start code.
    expect(h264Codec(new Uint8Array([0, 0, 0, 1, 39, 66, 192, 42, 1]))).toBe(
      "avc1.42C02A",
    );
    // A picture without one.
    expect(
      h264Codec(new Uint8Array([0, 0, 0, 1, 101, 136, 132, 0])),
    ).toBeNull();
  });

  it("types characters as text, and sends shortcuts and named keys as keys", () => {
    expect(keyEvent({ ...keys, key: "é" }, "down")).toEqual({
      kind: "text_commit",
      text: "é",
    });
    // Shift only changes the character, so it's still text, and text has no key going up.
    expect(keyEvent({ ...keys, shiftKey: true, key: "A" }, "down")).toEqual({
      kind: "text_commit",
      text: "A",
    });
    expect(keyEvent({ ...keys, key: "a" }, "up")).toBeNull();
    expect(keyEvent({ ...keys, ctrlKey: true, key: "C" }, "down")).toEqual({
      kind: "key",
      key: "c",
      state: "down",
      modifiers: ["control"],
      repeat: false,
    });
    expect(
      keyEvent({ ...keys, metaKey: true, key: " ", repeat: true }, "up"),
    ).toEqual({
      kind: "key",
      key: "space",
      state: "up",
      modifiers: ["command"],
      repeat: false,
    });
    expect(keyEvent({ ...keys, key: "Enter" }, "down")).toMatchObject({
      kind: "key",
      key: "enter",
    });
  });

  it("maps a pointer across the picture, not the bars around it", () => {
    // A 1600×800 desktop in a 1000×1000 box: 1000×500, centred with 250px bars.
    const box = contained(
      { left: 10, top: 20, width: 1000, height: 1000 },
      1600,
      800,
    );
    expect(box).toEqual({ left: 10, top: 270, width: 1000, height: 500 });
    expect(normalized({ clientX: 510, clientY: 520 }, box)).toEqual({
      x_normalized: 0.5,
      y_normalized: 0.5,
    });
    expect(normalized({ clientX: 10, clientY: 30 }, box).y_normalized).toBe(0);
  });
});

describe("a chat's display on the computer's screen", () => {
  it("is asked for by the chat's id, and the primary desktop by none", () => {
    expect(screenPath()).toBe("/api/computer/screen");
    expect(screenPath(null)).toBe("/api/computer/screen");
    expect(screenPath("a b/c")).toBe("/api/computer/screen?display=a%20b%2Fc");
  });
});
