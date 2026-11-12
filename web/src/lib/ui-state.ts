import { ApiError, pim, type StoredUiState } from "~/lib/pim-api";
import type { UiState } from "../../../src/ui-lang";

/**
 * Keeping what a ```ui block holds on the server, so a reload finds a draft,
 * a setting or a locked form as it was. The block's own state lives in the
 * component; this writes it behind the person's typing and reads it back
 * when the block is drawn again.
 */

/** How long the person has to stop changing a block before it is saved. */
export const SAVE_AFTER_MS = 500;
/** How long to wait before each new try of a write that failed; after the last, it waits for the next change. */
export const RETRY_AFTER_MS = [1000, 2000, 4000, 8000, 16000];

/** What the blocks of a message hold, by block id. Messages drawn together ask once. */
const loading = new Map<string, Promise<Record<string, StoredUiState>>>();

export function loadUiStates(
  message: string,
): Promise<Record<string, StoredUiState>> {
  const known = loading.get(message);
  if (known) return known;
  const started = pim.uiStates(message).finally(() => loading.delete(message));
  loading.set(message, started);
  return started;
}

type Save = (
  version: number,
  state: UiState,
  submitted: boolean,
) => Promise<StoredUiState>;

/**
 * Saves one block's state: the latest of what it was given, after the person
 * pauses, one write at a time. A write that fails is tried again, slower each
 * time. A write that finds the block saved from elsewhere since goes over it,
 * the last writer winning, unless that save submitted it: then what is kept
 * stands, and `onLocked` is told.
 */
export class UiStateWriter {
  #version = 0;
  #latest: { state: UiState; submitted: boolean } | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing = false;
  #failures = 0;
  #stopped = false;

  constructor(
    private readonly save: Save,
    private readonly onLocked: (stored: StoredUiState) => void,
  ) {}

  /** The version the server holds, as it was read. */
  adopt(version: number) {
    this.#version = Math.max(this.#version, version);
  }

  /** Saves `state` once the person pauses; at once when `now`, as a submit does. */
  write(state: UiState, { submitted = false, now = false } = {}) {
    if (this.#stopped) return;
    this.#latest = { state, submitted };
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (now) {
      this.#failures = 0;
      void this.#run();
      return;
    }
    const retry = RETRY_AFTER_MS[this.#failures - 1] ?? 0;
    this.#timer = setTimeout(
      () => void this.#run(),
      Math.max(SAVE_AFTER_MS, retry),
    );
  }

  /** Saves what waits, without waiting for a pause: the block is going away. */
  flush() {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    void this.#run();
  }

  async #run() {
    if (this.#writing || this.#latest === null || this.#stopped) return;
    this.#timer = null;
    const sent = this.#latest;
    this.#latest = null;
    this.#writing = true;
    try {
      const saved = await this.save(this.#version, sent.state, sent.submitted);
      this.#version = saved.version;
      this.#failures = 0;
      if (saved.submitted) this.#stopped = true;
      this.#writing = false;
      // Changed while it wrote, with the pause over before it finished: write it now.
      if (this.#latest !== null && this.#timer === null) void this.#run();
      return;
    } catch (error) {
      const current =
        error instanceof ApiError && error.status === 409
          ? (error.body?.current as StoredUiState | null | undefined)
          : undefined;
      if (error instanceof ApiError && error.status === 409) {
        // Saved from elsewhere since: what the server holds is read, and this goes over it.
        this.#version = current?.version ?? 0;
        if (current?.submitted) {
          this.#stopped = true;
          this.#latest = null;
          this.onLocked(current);
        } else this.#latest ??= sent;
        this.#writing = false;
        if (this.#latest !== null) void this.#run();
        return;
      }
      // A refusal is no use trying again; the network or the server failing is.
      if (!(error instanceof ApiError) || error.status >= 500) {
        this.#failures += 1;
        this.#latest ??= sent;
        if (this.#failures <= RETRY_AFTER_MS.length && this.#timer === null) {
          this.#timer = setTimeout(
            () => void this.#run(),
            RETRY_AFTER_MS[this.#failures - 1],
          );
        }
      }
    }
    this.#writing = false;
  }
}
