import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useI18n } from "~/components/i18n";

export function SessionLink({ session }: { session: string }) {
  const { t } = useI18n();
  return (
    <Link
      to="/chat/$sessionId"
      params={{ sessionId: session }}
      className="underline-offset-2 hover:text-foreground hover:underline"
    >
      {t("openChat")}
    </Link>
  );
}

/** The frame of the list pages (notifications, settings). */
export function Page({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 md:py-12">
        <h1 className="font-semibold text-2xl">{title}</h1>
        <p className="mt-1 mb-8 text-muted-foreground text-sm">{description}</p>
        {children}
      </div>
    </main>
  );
}

export function EmptyState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
      {icon}
      {text}
    </div>
  );
}
