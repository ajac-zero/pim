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

/** A size for people: bytes, kB or MB. */
export function formatBytes(
  bytes: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  if (bytes < 1000) return `${formatNumber(bytes)} B`;
  if (bytes < 1_000_000) {
    return `${formatNumber(bytes / 1000, { maximumFractionDigits: 1 })} kB`;
  }
  return `${formatNumber(bytes / 1_000_000, { maximumFractionDigits: 1 })} MB`;
}
