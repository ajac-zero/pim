import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type CanvasSearch, openCanvasTab } from "~/lib/canvas";

/** A file opens beside its chat, or on its own page outside a chat. */
export function FileLink({
  path,
  children,
  className,
  title,
}: {
  path: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const sessionId = useParams({
    strict: false,
    select: (params) => params.sessionId,
  });
  return sessionId ? (
    <Link
      to="/chat/$sessionId"
      params={{ sessionId }}
      search={(previous: CanvasSearch) => openCanvasTab(previous, path)}
      className={className}
      title={title}
    >
      {children}
    </Link>
  ) : (
    <Link to="/files" search={{ path }} className={className} title={title}>
      {children}
    </Link>
  );
}
