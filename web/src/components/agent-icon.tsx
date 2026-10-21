import { useRef, useState } from "react";
import { toast } from "sonner";
import { type TranslationKey, useI18n } from "~/components/i18n";
import {
  Baby,
  Bike,
  BookOpen,
  Bot,
  Brain,
  Briefcase,
  Calendar,
  Camera,
  Cat,
  ChefHat,
  ChevronLeft,
  ChevronRight,
  Code,
  Coffee,
  Dog,
  Dumbbell,
  Flower2,
  Footprints,
  Gamepad2,
  Globe,
  GraduationCap,
  Heart,
  House,
  ImagePlus,
  Leaf,
  Lightbulb,
  type LucideIcon,
  Mail,
  Map as MapIcon,
  Music,
  Palette,
  PenLine,
  Plane,
  Rocket,
  Shield,
  ShoppingCart,
  Smile,
  Sparkles,
  Star,
  Stethoscope,
  Terminal,
  Wallet,
  Wrench,
  Zap,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import type { Agent } from "~/lib/pim-api";
import { cn } from "~/lib/utils";

/** The icons an agent can show, by the name the API keeps. The first is the default. */
export const ICONS: Record<string, LucideIcon> = {
  bot: Bot,
  sparkles: Sparkles,
  rocket: Rocket,
  brain: Brain,
  lightbulb: Lightbulb,
  zap: Zap,
  star: Star,
  heart: Heart,
  smile: Smile,
  briefcase: Briefcase,
  calendar: Calendar,
  mail: Mail,
  "pen-line": PenLine,
  "book-open": BookOpen,
  "graduation-cap": GraduationCap,
  code: Code,
  terminal: Terminal,
  wrench: Wrench,
  shield: Shield,
  globe: Globe,
  plane: Plane,
  map: MapIcon,
  house: House,
  "shopping-cart": ShoppingCart,
  wallet: Wallet,
  "chef-hat": ChefHat,
  coffee: Coffee,
  dumbbell: Dumbbell,
  footprints: Footprints,
  bike: Bike,
  stethoscope: Stethoscope,
  leaf: Leaf,
  "flower-2": Flower2,
  dog: Dog,
  cat: Cat,
  baby: Baby,
  music: Music,
  palette: Palette,
  camera: Camera,
  "gamepad-2": Gamepad2,
};

const EMOJIS = [
  "🤖",
  "✨",
  "🚀",
  "🧠",
  "💡",
  "⚡",
  "⭐",
  "❤️",
  "😊",
  "😎",
  "🦊",
  "🐱",
  "🐶",
  "🦉",
  "🐙",
  "🌱",
  "🏃",
  "💪",
  "🧘",
  "🍳",
  "☕",
  "🍎",
  "📚",
  "🎓",
  "💼",
  "📅",
  "✉️",
  "📝",
  "💻",
  "🛠️",
  "💰",
  "🛒",
  "✈️",
  "🗺️",
  "🏠",
  "🎨",
  "🎵",
  "📷",
  "🎮",
  "🌍",
];

/**
 * Each color the API accepts, as a tinted tile, a glyph's color and a swatch.
 * The `agent-*` colors come from the active theme (src/styles/app.css).
 */
const COLORS: Record<
  string,
  { tile: string; text: string; swatch: string; label: TranslationKey }
> = {
  gray: {
    tile: "bg-agent-gray/15 text-agent-gray",
    text: "text-agent-gray",
    swatch: "bg-agent-gray",
    label: "colorGray",
  },
  red: {
    tile: "bg-agent-red/15 text-agent-red",
    text: "text-agent-red",
    swatch: "bg-agent-red",
    label: "colorRed",
  },
  orange: {
    tile: "bg-agent-orange/15 text-agent-orange",
    text: "text-agent-orange",
    swatch: "bg-agent-orange",
    label: "colorOrange",
  },
  amber: {
    tile: "bg-agent-amber/15 text-agent-amber",
    text: "text-agent-amber",
    swatch: "bg-agent-amber",
    label: "colorAmber",
  },
  green: {
    tile: "bg-agent-green/15 text-agent-green",
    text: "text-agent-green",
    swatch: "bg-agent-green",
    label: "colorGreen",
  },
  teal: {
    tile: "bg-agent-teal/15 text-agent-teal",
    text: "text-agent-teal",
    swatch: "bg-agent-teal",
    label: "colorTeal",
  },
  blue: {
    tile: "bg-agent-blue/15 text-agent-blue",
    text: "text-agent-blue",
    swatch: "bg-agent-blue",
    label: "colorBlue",
  },
  indigo: {
    tile: "bg-agent-indigo/15 text-agent-indigo",
    text: "text-agent-indigo",
    swatch: "bg-agent-indigo",
    label: "colorIndigo",
  },
  violet: {
    tile: "bg-agent-violet/15 text-agent-violet",
    text: "text-agent-violet",
    swatch: "bg-agent-violet",
    label: "colorViolet",
  },
  pink: {
    tile: "bg-agent-pink/15 text-agent-pink",
    text: "text-agent-pink",
    swatch: "bg-agent-pink",
    label: "colorPink",
  },
};

/** The tile behind an agent's symbol: tinted with its color, or the theme's. */
export function tileClass(color: string | null): string {
  return (color && COLORS[color]?.tile) || "bg-primary/10 text-primary";
}

/** Named icons are lowercase words; anything else the API keeps is an emoji. */
const isIconName = (symbol: string) => /^[a-z][a-z0-9-]*$/.test(symbol);

type Look = Pick<Agent, "id" | "icon" | "symbol" | "color">;

/** An agent's symbol alone: its emoji, or its icon, or a robot. */
function Glyph({
  symbol,
  className,
}: {
  symbol: string | null;
  className?: string;
}) {
  if (symbol && !isIconName(symbol)) {
    // Drawn in an SVG, an emoji scales with the box like the icons do.
    return (
      <svg
        viewBox="0 0 24 24"
        className={cn("shrink-0", className)}
        aria-hidden="true"
      >
        <text
          x="12"
          y="13"
          fontSize="19"
          textAnchor="middle"
          dominantBaseline="central"
        >
          {symbol}
        </text>
      </svg>
    );
  }
  const Icon = (symbol && ICONS[symbol]) || Bot;
  return <Icon className={cn("shrink-0", className)} aria-hidden="true" />;
}

/**
 * An agent's icon: its uploaded image, or its chosen icon or emoji in its
 * color, or a robot. `className` sizes it. As a `tile`, the symbol sits on a
 * tinted square.
 */
export function AgentIcon({
  agent,
  className,
  tile = false,
  src,
}: {
  agent: Look;
  className?: string;
  tile?: boolean;
  /** An image to show instead, such as one not uploaded yet. */
  src?: string;
}) {
  if (src !== undefined || agent.icon !== null) {
    return (
      <img
        // The version in the URL fetches it again when the icon changes.
        src={src ?? `/api/agents/${agent.id}/icon?v=${agent.icon}`}
        alt=""
        className={cn("shrink-0 rounded-sm object-cover", className)}
      />
    );
  }
  if (tile) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-lg",
          tileClass(agent.color),
          className,
        )}
        aria-hidden="true"
      >
        <Glyph symbol={agent.symbol} className="size-[60%]" />
      </span>
    );
  }
  return (
    <Glyph
      symbol={agent.symbol}
      className={cn(agent.color && COLORS[agent.color]?.text, className)}
    />
  );
}

/** Where a published template's uploaded icon is, if it has one. */
export const templateIconSrc = (template: Pick<Look, "id" | "icon">) =>
  template.icon === null
    ? undefined
    : `/api/templates/${template.id}/icon?v=${template.icon}`;

/** What the picker changes: the symbol and color, and an image to upload, the one saved, or none. */
export type LookChoice = {
  symbol: string | null;
  color: string | null;
  image: Blob | "saved" | null;
};

/** Icons or emoji per page of the compact picker: six across, four down. */
const PAGE = 24;

/**
 * Chooses an agent's look in a popover, without typing: pages of icons or
 * emoji to step through with arrows, an image to upload, and a color for
 * the first two. Every row follows the grid's six columns: the tabs span
 * them, the arrows sit in the first and last, and the colors run between
 * the centers of those two.
 */
export function CompactLookPicker({
  value,
  onChange,
}: {
  value: LookChoice;
  onChange: (value: LookChoice) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"icon" | "emoji" | "image">(
    value.image !== null
      ? "image"
      : value.symbol && !isIconName(value.symbol)
        ? "emoji"
        : "icon",
  );
  const listOf = (name: "icon" | "emoji" | "image") =>
    name === "icon" ? Object.keys(ICONS) : EMOJIS;
  const chosen = (name: "icon" | "emoji" | "image") =>
    name === "icon" ? (value.symbol ?? "bot") : value.symbol;
  // A tab opens on the page that shows what is chosen.
  const pageFor = (name: "icon" | "emoji" | "image") =>
    Math.max(0, Math.floor(listOf(name).indexOf(chosen(name) ?? "") / PAGE));
  const symbols = listOf(tab);
  const selected = (symbol: string) =>
    value.image === null && chosen(tab) === symbol;
  const [page, setPage] = useState(() => pageFor(tab));
  const pages = Math.ceil(symbols.length / PAGE);
  const fileInput = useRef<HTMLInputElement>(null);
  const tabs = [
    ["icon", "lookIcon"],
    ["emoji", "lookEmoji"],
    ["image", "lookImage"],
  ] as const;

  return (
    <div className="w-71 space-y-3">
      <div
        role="tablist"
        aria-label={t("agentLook")}
        className="grid grid-cols-3 rounded-lg bg-muted p-0.5"
      >
        {tabs.map(([name, label]) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => {
              setTab(name);
              setPage(pageFor(name));
            }}
            className={cn(
              "rounded-md py-1 text-sm",
              tab === name
                ? "bg-background shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {tab === "image" ? (
        <div className="flex h-57 flex-col items-center justify-center gap-2 rounded-xl border border-dashed">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label={t("uploadIcon")}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try {
                onChange({ ...value, image: await iconFromFile(file) });
              } catch {
                toast.error(t("notAnImage"));
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => fileInput.current?.click()}
          >
            <ImagePlus /> {t("uploadIcon")}
          </Button>
          {value.image !== null && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange({ ...value, image: null })}
            >
              {t("removeIcon")}
            </Button>
          )}
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-6 grid-rows-[repeat(4,2.75rem)] gap-1">
            {symbols.slice(page * PAGE, (page + 1) * PAGE).map((symbol) => (
              <button
                key={symbol}
                type="button"
                aria-label={symbol}
                aria-pressed={selected(symbol)}
                title={symbol}
                onClick={() =>
                  onChange({
                    ...value,
                    // The robot is the default: choosing it chooses no icon.
                    symbol: symbol === "bot" ? null : symbol,
                    image: null,
                  })
                }
                className={cn(
                  "flex size-11 items-center justify-center rounded-lg",
                  selected(symbol)
                    ? "bg-accent ring-2 ring-ring"
                    : "hover:bg-accent",
                )}
              >
                <Glyph
                  symbol={symbol}
                  className={tab === "icon" ? "size-5" : "size-6"}
                />
              </button>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-6 place-items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t("previousIcons")}
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft />
            </Button>
            <div
              role="img"
              aria-label={t("iconsPage", { page: page + 1, pages })}
              className="col-span-4 flex gap-1.5"
            >
              {Array.from({ length: pages }, (_, index) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: pages are positions.
                  key={index}
                  className={cn(
                    "size-1.5 rounded-full",
                    index === page ? "bg-foreground" : "bg-border",
                  )}
                />
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={t("nextIcons")}
              disabled={page === pages - 1}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
      {value.image === null && (
        <div
          role="radiogroup"
          aria-label={t("agentColor")}
          className="flex justify-between px-3"
        >
          {[
            {
              color: null,
              label: "defaultColor" as const,
              swatch: "bg-primary",
            },
            ...Object.entries(COLORS).map(([color, { label, swatch }]) => ({
              color,
              label,
              swatch,
            })),
          ].map(({ color, label, swatch }) => (
            <button
              key={color ?? "default"}
              type="button"
              role="radio"
              aria-checked={value.color === color}
              aria-label={t(label)}
              title={t(label)}
              onClick={() => onChange({ ...value, color })}
              className={cn(
                "size-5 rounded-full ring-offset-1 ring-offset-popover",
                swatch,
                value.color === color
                  ? "ring-2 ring-ring"
                  : "hover:ring-2 hover:ring-border",
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** Squares `file` to a small PNG, so a phone photo stays well under the size limit. */
export async function iconFromFile(file: File, size = 128): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const side = Math.min(bitmap.width, bitmap.height);
  canvas
    .getContext("2d")
    ?.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Not an image"))),
      "image/png",
    ),
  );
}
