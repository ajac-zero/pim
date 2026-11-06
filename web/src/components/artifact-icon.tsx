import {
  Code,
  FileCode2,
  FileText,
  ImageIcon,
  Workflow,
} from "~/components/icons";
import type { ArtifactKind } from "~/lib/pim-api";

export function ArtifactIcon({
  kind,
  className,
}: {
  kind: ArtifactKind;
  className?: string;
}) {
  const Icon = {
    html: FileCode2,
    markdown: FileText,
    svg: ImageIcon,
    mermaid: Workflow,
    jsx: Code,
  }[kind];
  return <Icon className={className} />;
}

/** What each kind is called, short, next to an app's name. */
export const ARTIFACT_KIND_NAMES: Record<ArtifactKind, string> = {
  html: "HTML",
  markdown: "Markdown",
  svg: "SVG",
  mermaid: "Mermaid",
  jsx: "React",
};
