import { lazy, Suspense } from "react";
import type { Markdown as Loaded } from "~/components/chat/markdown";
import { cn } from "~/lib/utils";

/**
 * Markdown, which is what draws a chat's messages and pulls in the renderer, the highlighter and the math and diagram
 * libraries (more than a megabyte of script). It is loaded when something first needs to draw some, not with the app's frame, so the
 * sidebar and the rest of the page appear while it loads; the text shows as written until it is there.
 */
const Rendered = lazy(() =>
  import("~/components/chat/markdown").then((module) => ({
    default: module.Markdown,
  })),
);

export function Markdown(props: React.ComponentProps<typeof Loaded>) {
  return (
    <Suspense
      fallback={
        <div className={cn("whitespace-pre-wrap break-words", props.className)}>
          {props.text}
        </div>
      }
    >
      <Rendered {...props} />
    </Suspense>
  );
}
