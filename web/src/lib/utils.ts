import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Model catalogs may prefix a display name with its provider, as in "Anthropic: Claude Sonnet". */
export function modelName(name: string) {
  return name.replace(/^[^:]+:\s+/, "");
}

/** Whether this computer's shortcuts use ⌘ rather than Ctrl. */
export const MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);
