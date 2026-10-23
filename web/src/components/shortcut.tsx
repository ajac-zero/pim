import { MAC } from "~/lib/utils";

/** A shortcut's keys, with the modifier a Mac or another computer uses. Hidden on touch-only devices. */
export function Shortcut({ keys }: { keys: string }) {
  return (
    <span className="ml-auto hidden text-[13px] text-muted-foreground [@media(hover:hover)_and_(pointer:fine)]:inline">
      {MAC ? "⌘" : "Ctrl+"}
      {keys}
    </span>
  );
}
