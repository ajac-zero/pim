import {
  FileArchive,
  FileAudio,
  FileCode2,
  FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
  Presentation,
} from "~/components/icons";
import { cn } from "~/lib/utils";

/** What kind of file an attachment is, by its extension or else its type, as an icon and a color. */
const FILE_KINDS: {
  extensions: readonly string[];
  type?: string;
  icon: LucideIcon;
  color: string;
}[] = [
  {
    extensions: ["pdf"],
    icon: FileText,
    color: "text-agent-red",
  },
  {
    extensions: ["doc", "docx", "odt", "rtf", "pages", "txt", "md"],
    icon: FileText,
    color: "text-agent-blue",
  },
  {
    extensions: ["csv", "tsv", "xls", "xlsx", "ods", "numbers"],
    icon: FileSpreadsheet,
    color: "text-agent-green",
  },
  {
    extensions: ["ppt", "pptx", "odp", "key"],
    icon: Presentation,
    color: "text-agent-orange",
  },
  {
    extensions: ["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"],
    icon: FileArchive,
    color: "text-agent-amber",
  },
  {
    extensions: [
      "json",
      "js",
      "mjs",
      "ts",
      "tsx",
      "jsx",
      "py",
      "rb",
      "go",
      "rs",
      "java",
      "c",
      "h",
      "cpp",
      "sh",
      "sql",
      "html",
      "css",
      "xml",
      "yaml",
      "yml",
      "toml",
      "ipynb",
    ],
    icon: FileCode2,
    color: "text-agent-teal",
  },
  {
    extensions: [],
    type: "image/",
    icon: FileImage,
    color: "text-agent-indigo",
  },
  {
    extensions: [],
    type: "audio/",
    icon: FileAudio,
    color: "text-agent-pink",
  },
  {
    extensions: [],
    type: "video/",
    icon: FileVideo,
    color: "text-agent-violet",
  },
];

export function FileKindIcon({ name, type }: { name: string; type: string }) {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const kind =
    FILE_KINDS.find((candidate) => candidate.extensions.includes(extension)) ??
    FILE_KINDS.find(
      (candidate) => candidate.type && type.startsWith(candidate.type),
    );
  const Icon = kind?.icon ?? FileIcon;
  return (
    <Icon
      className={cn("size-4 shrink-0", kind?.color ?? "text-muted-foreground")}
    />
  );
}
