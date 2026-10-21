import { Link, useParams } from "@tanstack/react-router";
import type { ReactNode } from "react";

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
      search={{ file: path }}
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
