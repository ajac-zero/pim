import { useSyncExternalStore } from "react";
import { cn } from "~/lib/utils";

/**
 * A size the person chose, such as a panel's width, kept in this browser
 * like the theme. Every component reading the same key sees a change.
 */
export function useStoredSize(
  key: string,
  fallback: number,
): [number, (size: number | null) => void] {
  const stored = useSyncExternalStore(
    subscribe,
    () => localStorage.getItem(key),
    () => null,
  );
  const size = stored === null ? Number.NaN : Number(stored);
  const set = (next: number | null) => {
    if (next === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(next));
    for (const listener of listeners) listener();
  };
  return [Number.isFinite(size) ? size : fallback, set];
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The edge of a panel the person drags to resize it, or moves with the
 * arrow keys once it has focus; a double click puts back the default size.
 * It sits over the panel's border, at the side `edge` names. The parent
 * keeps the size and turns a pointer position into one (`fromPointer`).
 */
export function ResizeHandle({
  label,
  edge,
  value,
  min,
  max,
  step,
  onChange,
  onReset,
  fromPointer,
  className,
}: {
  label: string;
  edge: "left" | "right";
  value: number;
  min: number;
  max: number;
  /** How far one arrow key press moves it. */
  step: number;
  onChange: (value: number) => void;
  onReset: () => void;
  fromPointer: (clientX: number) => number;
  className?: string;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  // The arrow that points away from the panel makes it bigger.
  const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
  const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a splitter; <hr> can't take focus or be dragged.
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={label}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        // While dragging, nothing animates or gets selected, and the cursor stays.
        document.documentElement.dataset.resizing = "";
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onChange(clamp(fromPointer(event.clientX)));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        delete document.documentElement.dataset.resizing;
      }}
      onLostPointerCapture={() => {
        delete document.documentElement.dataset.resizing;
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === grow) onChange(clamp(value + step));
        else if (event.key === shrink) onChange(clamp(value - step));
        else if (event.key === "Home") onChange(min);
        else if (event.key === "End") onChange(max);
        else return;
        event.preventDefault();
      }}
      className={cn(
        "group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none",
        edge === "right" ? "-right-1" : "-left-1",
        className,
      )}
    >
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-ring/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100" />
    </div>
  );
}
