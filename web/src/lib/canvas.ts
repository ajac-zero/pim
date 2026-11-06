import { FILES_ROOT } from "~/lib/pim-api";

/** What a chat's search names of its canvas: the open tabs, each a file's path or an app's id. */
export type CanvasSearch = {
  artifact?: string;
  v?: number;
  file?: string;
  tabs?: string[];
};

export const isFilePath = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith(`${FILES_ROOT}/`);

/** The canvas showing `tab`, with the tabs already open and `tab` among them. */
export function openCanvasTab(
  previous: CanvasSearch,
  tab: string,
  v?: number,
): CanvasSearch {
  // A lone tab needs no list; the route adds it back.
  const tabs = [...new Set([...(previous.tabs ?? []), tab])];
  const rest = tabs.length > 1 ? { tabs } : {};
  return isFilePath(tab)
    ? { file: tab, ...rest }
    : { artifact: tab, ...(v && { v }), ...rest };
}

/** The canvas after closing `tab`: its neighbor is shown, and the last tab closes the canvas. */
export function closeCanvasTab(tabs: string[], tab: string): CanvasSearch {
  const rest = tabs.filter((other) => other !== tab);
  const next = rest[Math.min(tabs.indexOf(tab), rest.length - 1)];
  return next ? { ...openCanvasTab({ tabs: rest }, next) } : {};
}
