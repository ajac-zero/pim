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
  icon,
  description,
  children,
}: {
  title: string;
  /** Shown before the title. */
  icon?: ReactNode;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-[768px] px-6 py-8 md:py-12">
        <h1 className="flex items-center gap-3 font-semibold text-xl">
          {icon}
          {title}
        </h1>
        <p className="mt-1 mb-8 text-muted-foreground text-sm">{description}</p>
        {children}
      </div>
    </main>
  );
}

export function EmptyState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
      <span className="[&>svg]:size-4">{icon}</span>
      {text}
    </div>
  );
}
