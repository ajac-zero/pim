/**
 * Your computer's desktop, live: a client of Cua's media plane (rcdp wire
 * v2, `libs/cua/proto/MEDIA.md` in github.com/trycua/cua), which the space
 * passes through from cua-spacesd on the computer unread. The server speaks
 * first: `hello`, then `session_opened`. Then H.264 of the whole display
 * comes as binary packets, which WebCodecs decodes onto a canvas, and what
 * the person does on the canvas goes back as `interactive_input` batches.
 * Each frame decoded is acknowledged (`frame_ack`), which paces the stream to
 * what this browser and its connection keep up with.
 */

/** Where the app shows the desktop: a socket of the stream (`src/computer.ts`'s `COMPUTER_SCREEN_PATH`). */
export const COMPUTER_SCREEN_PATH = "/api/computer/screen";

/** A video packet's header, as the media plane describes each frame. */
export type VideoFrame = {
  session_id: string;
  sequence: number;
  codec_epoch: number;
  width_px: number;
  height_px: number;
  capture_timestamp_us: number;
  codec: string;
  keyframe: boolean;
};

/**
 * A binary packet: two big-endian lengths, a JSON header that long, and
 * the payload. Only video is read; anything else (audio, which isn't asked
 * for) is null.
 */
export function readPacket(
  packet: ArrayBuffer,
): { frame: VideoFrame; payload: Uint8Array } | null {
  if (packet.byteLength < 8) return null;
  const view = new DataView(packet);
  const headerLength = view.getUint32(0);
  const payloadLength = view.getUint32(4);
  if (8 + headerLength + payloadLength > packet.byteLength) return null;
  let header: { direction?: unknown; message?: unknown };
  try {
    header = JSON.parse(
      new TextDecoder().decode(new Uint8Array(packet, 8, headerLength)),
    );
  } catch {
    return null;
  }
  if (header.direction !== "video") return null;
  return {
    frame: header.message as VideoFrame,
    payload: new Uint8Array(packet, 8 + headerLength, payloadLength),
  };
}

/** The WebCodecs codec of an H.264 keyframe, from its sequence parameter set: `avc1.` with its profile, constraints and level. */
export function h264Codec(annexB: Uint8Array): string | null {
  for (let at = 0; at + 4 < annexB.length; at++) {
    const start =
      annexB[at] === 0 &&
      annexB[at + 1] === 0 &&
      (annexB[at + 2] === 1 || (annexB[at + 2] === 0 && annexB[at + 3] === 1));
    if (!start) continue;
    const nal = at + (annexB[at + 2] === 1 ? 3 : 4);
    if (((annexB[nal] ?? 0) & 31) === 7 && nal + 3 < annexB.length) {
      return `avc1.${[...annexB.subarray(nal + 1, nal + 4)]
        .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
        .join("")}`;
    }
    at = nal;
  }
  return null;
}

/** One input event, as the media plane takes it; coordinates are 0–1 across the desktop. */
export type InputEvent =
  | { kind: "text_commit"; text: string }
  | {
      kind: "key";
      key: string;
      state: "down" | "up";
      modifiers: Modifier[];
      repeat: boolean;
    }
  | {
      kind: "pointer";
      phase: "move" | "down" | "up";
      button: "left" | "middle" | "right" | null;
      x_normalized: number;
      y_normalized: number;
      modifiers: Modifier[];
    }
  | {
      kind: "scroll";
      x_normalized: number;
      y_normalized: number;
      delta_x: number;
      delta_y: number;
      phase: "none";
      momentum_phase: "none";
      precise: boolean;
    };

type Modifier = "shift" | "control" | "option" | "command";

type Keys = {
  key: string;
  repeat?: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

export function modifiers(event: Omit<Keys, "key">): Modifier[] {
  const held: Modifier[] = [];
  if (event.shiftKey) held.push("shift");
  if (event.ctrlKey) held.push("control");
  if (event.altKey) held.push("option");
  if (event.metaKey) held.push("command");
  return held;
}

/**
 * A key, as the desktop takes it: a character typed without a shortcut
 * modifier is text, committed once as the key goes down; anything else,
 * such as Enter, an arrow or Ctrl+C, is the key itself going down and up,
 * by its name in lowercase.
 */
export function keyEvent(event: Keys, state: "down" | "up"): InputEvent | null {
  if (event.key === "Unidentified" || event.key === "Process") return null;
  const shortcut = event.ctrlKey || event.metaKey || event.altKey;
  if (event.key.length === 1 && !shortcut) {
    return state === "down" ? { kind: "text_commit", text: event.key } : null;
  }
  return {
    kind: "key",
    key: event.key === " " ? "space" : event.key.toLowerCase(),
    state,
    modifiers: modifiers(event),
    repeat: state === "down" && event.repeat === true,
  };
}

const BUTTONS = ["left", "middle", "right"] as const;

/** Where a pointer is on the desktop shown in `box`, as fractions of it, kept inside it. */
export function normalized(
  event: { clientX: number; clientY: number },
  box: { left: number; top: number; width: number; height: number },
): { x_normalized: number; y_normalized: number } {
  const clamp = (value: number) =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return {
    x_normalized: clamp((event.clientX - box.left) / box.width),
    y_normalized: clamp((event.clientY - box.top) / box.height),
  };
}

/** Frames waiting in the decoder past which it's behind: it skips to the next keyframe. */
const MAX_DECODE_QUEUE = 4;
/** How long the stream may send no video before it's asked for a keyframe, in case it's waiting for one. */
const SILENT_MS = 3_000;

export type ScreenState =
  | { status: "connecting" }
  | { status: "live"; width: number; height: number }
  | { status: "closed"; code: number; reason: string };

/**
 * Plays the desktop on `canvas` and sends what the person does there: it
 * takes the canvas's pointer, wheel, keyboard and paste. `onState` hears
 * when it's live, at what size, and when the stream closed.
 */
export class ComputerScreen {
  readonly #canvas: HTMLCanvasElement;
  readonly #onState: (state: ScreenState) => void;
  readonly #socket: WebSocket;
  #session = "";
  #decoder: VideoDecoder | null = null;
  #epoch = -1;
  #sequence = 1;
  #pending: InputEvent[] = [];
  #flush = 0;
  /**
   * Whether the stream takes `frame_ack`, and the frames being decoded, by
   * their timestamps: each one decoded is acknowledged, so the stream sends
   * no more than this browser keeps up with (it leaves frames out, and
   * lowers its bitrate, for a slow connection or device).
   */
  #acks = false;
  readonly #decoding = new Map<number, { sequence: number; at: number }>();
  /**
   * Waiting for a keyframe to decode from, after frames were left out; when
   * one was last asked for, and when video last came. The stream stops
   * sending, waiting for a keyframe, when this browser fell too far behind,
   * and sends none of itself while the desktop changes: a stream silent for
   * `SILENT_MS` is asked for one, once until video comes again.
   */
  #awaitingKeyframe = false;
  #askedAt = 0;
  #videoAt = performance.now();
  #askedSinceVideo = false;
  readonly #watch = setInterval(() => {
    if (this.#askedSinceVideo || performance.now() - this.#videoAt < SILENT_MS)
      return;
    this.#askedSinceVideo = true;
    this.#askKeyframe();
  }, 1_000);
  readonly #listeners: [string, EventListener][] = [];

  constructor(
    canvas: HTMLCanvasElement,
    onState: (state: ScreenState) => void,
  ) {
    this.#canvas = canvas;
    this.#onState = onState;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    this.#socket = new WebSocket(
      `${scheme}://${location.host}${COMPUTER_SCREEN_PATH}`,
    );
    this.#socket.binaryType = "arraybuffer";
    this.#socket.addEventListener("message", (event) => this.#heard(event));
    this.#socket.addEventListener("close", (event) => {
      this.#decoder?.close();
      this.#decoder = null;
      this.#onState({
        status: "closed",
        code: event.code,
        reason: event.reason,
      });
    });
    this.#onState({ status: "connecting" });
    this.#listen();
  }

  /** Stops playing, and lets the canvas go. */
  close(): void {
    for (const [type, listener] of this.#listeners)
      this.#canvas.removeEventListener(type, listener);
    cancelAnimationFrame(this.#flush);
    clearInterval(this.#watch);
    this.#socket.close(1000);
    if (this.#decoder?.state !== "closed") this.#decoder?.close();
  }

  #control(type: string, payload: unknown): void {
    if (this.#socket.readyState === WebSocket.OPEN)
      this.#socket.send(JSON.stringify({ type, payload }));
  }

  #heard(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      this.#play(event.data as ArrayBuffer);
      return;
    }
    const message = JSON.parse(event.data) as {
      type: string;
      payload?: Record<string, unknown>;
    };
    const payload = message.payload ?? {};
    if (message.type === "hello") {
      this.#acks =
        Array.isArray(payload.capabilities) &&
        payload.capabilities.includes("frame_ack.v1");
    } else if (message.type === "session_opened") {
      this.#session = String(payload.session_id);
      const geometry = payload.geometry as
        | { width_px: number; height_px: number }
        | undefined;
      if (geometry) this.#resize(geometry.width_px, geometry.height_px);
    } else if (
      message.type === "error" &&
      typeof payload.expected_sequence === "number"
    ) {
      // Input it lost count of: it says where to go on from.
      this.#sequence = payload.expected_sequence;
    }
  }

  #resize(width: number, height: number): void {
    if (this.#canvas.width !== width) this.#canvas.width = width;
    if (this.#canvas.height !== height) this.#canvas.height = height;
    this.#onState({ status: "live", width, height });
  }

  #play(packet: ArrayBuffer): void {
    const read = readPacket(packet);
    if (read?.frame.codec !== "h264") return;
    this.#videoAt = performance.now();
    this.#askedSinceVideo = false;
    const { frame, payload } = read;
    // A new encoder starts with a keyframe, which says how to decode what follows.
    const decoder =
      frame.codec_epoch === this.#epoch && this.#decoder
        ? this.#decoder
        : frame.keyframe
          ? this.#configure(
              h264Codec(payload) ?? "avc1.42E01F",
              frame.codec_epoch,
            )
          : null;
    if (!decoder) return;
    // A decoder that can't keep up (or a frame lost before) goes on from the next keyframe, without what's in between.
    if (
      !frame.keyframe &&
      (this.#awaitingKeyframe || decoder.decodeQueueSize > MAX_DECODE_QUEUE)
    ) {
      this.#awaitingKeyframe = true;
      this.#askKeyframe();
      return;
    }
    this.#awaitingKeyframe = false;
    this.#decoding.set(frame.capture_timestamp_us, {
      sequence: frame.sequence,
      at: performance.now(),
    });
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: frame.keyframe ? "key" : "delta",
          timestamp: frame.capture_timestamp_us,
          data: payload,
        }),
      );
    } catch {
      this.#lost();
    }
  }

  #configure(codec: string, epoch: number): VideoDecoder {
    if (this.#decoder?.state !== "closed") this.#decoder?.close();
    const context = this.#canvas.getContext("2d");
    const decoder = new VideoDecoder({
      output: (picture) => {
        this.#resize(picture.displayWidth, picture.displayHeight);
        context?.drawImage(picture, 0, 0);
        this.#decoded(picture.timestamp, decoder.decodeQueueSize);
        picture.close();
      },
      error: () => this.#lost(),
    });
    decoder.configure({ codec, optimizeForLatency: true });
    this.#decoder = decoder;
    this.#epoch = epoch;
    return decoder;
  }

  /** A frame was decoded and drawn: the stream hears of it, with how long it took and how many wait. */
  #decoded(timestamp: number, waiting: number): void {
    const decoding = this.#decoding.get(timestamp);
    // Frames the decoder skipped are done with too.
    for (const at of this.#decoding.keys())
      if (at <= timestamp) this.#decoding.delete(at);
    if (!decoding || !this.#acks) return;
    this.#control("frame_ack", {
      session_id: this.#session,
      sequence: decoding.sequence,
      decode_us: Math.round((performance.now() - decoding.at) * 1000),
      decode_queue: waiting,
    });
  }

  /** Decoding failed: it starts again from the next keyframe, which it asks for. */
  #lost(): void {
    if (this.#decoder?.state !== "closed") this.#decoder?.close();
    this.#decoder = null;
    this.#decoding.clear();
    this.#epoch = -1;
    this.#askKeyframe();
  }

  /** Asks the stream for a keyframe, at most once a second. */
  #askKeyframe(): void {
    const now = performance.now();
    if (!this.#session || now - this.#askedAt < 1_000) return;
    this.#askedAt = now;
    this.#control("request_keyframe", { session_id: this.#session });
  }

  /** Sends what the person did, a batch per animation frame, so pointer moves between frames don't pile up. */
  #send(event: InputEvent): void {
    const last = this.#pending.at(-1);
    if (
      event.kind === "pointer" &&
      event.phase === "move" &&
      last?.kind === "pointer" &&
      last.phase === "move"
    )
      this.#pending[this.#pending.length - 1] = event;
    else this.#pending.push(event);
    this.#flush ||= requestAnimationFrame(() => {
      this.#flush = 0;
      const events = this.#pending.splice(0);
      if (!events.length || !this.#session) return;
      this.#control("interactive_input", {
        session_id: this.#session,
        first_sequence: this.#sequence,
        events,
      });
      this.#sequence += events.length;
    });
  }

  #on<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    this.#canvas.addEventListener(type, listener, options);
    this.#listeners.push([type, listener as EventListener]);
  }

  #listen(): void {
    const canvas = this.#canvas;
    const at = (event: { clientX: number; clientY: number }) =>
      normalized(event, canvas.getBoundingClientRect());
    this.#on("pointerdown", (event) => {
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      this.#send({
        kind: "pointer",
        phase: "down",
        button: BUTTONS[event.button] ?? "left",
        ...at(event),
        modifiers: modifiers(event),
      });
    });
    this.#on("pointermove", (event) => {
      this.#send({
        kind: "pointer",
        phase: "move",
        button: null,
        ...at(event),
        modifiers: modifiers(event),
      });
    });
    this.#on("pointerup", (event) => {
      this.#send({
        kind: "pointer",
        phase: "up",
        button: BUTTONS[event.button] ?? "left",
        ...at(event),
        modifiers: modifiers(event),
      });
    });
    this.#on("contextmenu", (event) => event.preventDefault());
    this.#on(
      "wheel",
      (event) => {
        event.preventDefault();
        // Lines and pages as pixels, as the desktop scrolls by pixels.
        const scale =
          event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 400 : 1;
        this.#send({
          kind: "scroll",
          ...at(event),
          delta_x: event.deltaX * scale,
          delta_y: event.deltaY * scale,
          phase: "none",
          momentum_phase: "none",
          precise: event.deltaMode === 0,
        });
      },
      { passive: false },
    );
    for (const state of ["down", "up"] as const) {
      this.#on(state === "down" ? "keydown" : "keyup", (event) => {
        // Pasting brings this device's clipboard over, as typed text (below), rather than pasting the computer's own.
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v")
          return;
        const input = keyEvent(event, state);
        if (!input) return;
        event.preventDefault();
        this.#send(input);
      });
    }
    this.#on("paste", (event) => {
      const text = event.clipboardData?.getData("text");
      event.preventDefault();
      if (text) this.#send({ kind: "text_commit", text });
    });
  }
}

/** Whether this browser can play the desktop: it decodes H.264 with WebCodecs. */
export function canPlayScreen(): boolean {
  return typeof VideoDecoder !== "undefined";
}
