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
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type TranslationKey, useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { Agent } from "~/lib/pim-api";
import { cn } from "~/lib/utils";

/** The icons an agent can show, by the name the API keeps. The first is the default. */
const ICONS: Record<string, LucideIcon> = {
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

// biome-ignore lint/complexity/useRegexLiterals: as a literal, the v flag needs a newer TypeScript target than the app's.
const emojiPattern = new RegExp("^\\p{RGI_Emoji}$", "v");

/** The last emoji in what was typed or pasted, if any. */
function lastEmoji(text: string): string | undefined {
  return [...new Intl.Segmenter().segment(text)]
    .map((part) => part.segment)
    .findLast((segment) => emojiPattern.test(segment));
}

/** Chooses how an agent looks: an icon, an emoji or an uploaded image, and a color for the first two. */
export function AgentLookPicker({
  agent,
  value,
  onChange,
}: {
  agent?: Pick<Agent, "id" | "icon">;
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
  const [typed, setTyped] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!(value.image instanceof Blob)) return setPreview(undefined);
    const url = URL.createObjectURL(value.image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [value.image]);
  const shown: Look = {
    id: agent?.id ?? "",
    icon: value.image === "saved" ? (agent?.icon ?? null) : null,
    symbol: value.symbol,
    color: value.color,
  };
  // Choosing an icon or an emoji puts it in place of an image.
  const choose = (symbol: string | null) =>
    onChange({ ...value, symbol, image: null });

  return (
    <fieldset className="space-y-2">
      <legend className="font-medium text-sm">{t("agentLook")}</legend>
      <div className="flex gap-3">
        <AgentIcon
          agent={shown}
          tile
          src={value.image instanceof Blob ? preview : undefined}
          className="size-14 rounded-xl"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div
            role="tablist"
            aria-label={t("agentLook")}
            className="inline-flex rounded-lg bg-muted p-0.5"
          >
            {(["icon", "emoji", "image"] as const).map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm",
                  tab === name
                    ? "bg-background font-medium shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(
                  name === "icon"
                    ? "lookIcon"
                    : name === "emoji"
                      ? "lookEmoji"
                      : "lookImage",
                )}
              </button>
            ))}
          </div>
          {tab === "icon" && (
            <Choices>
              {Object.keys(ICONS).map((name) => {
                // The robot is the default: choosing it chooses no icon.
                const symbol = name === "bot" ? null : name;
                return (
                  <Choice
                    key={name}
                    label={name}
                    selected={
                      value.image === null && (value.symbol ?? "bot") === name
                    }
                    onSelect={() => choose(symbol)}
                  >
                    <Glyph symbol={name} className="size-4.5" />
                  </Choice>
                );
              })}
            </Choices>
          )}
          {tab === "emoji" && (
            <>
              <Choices>
                {EMOJIS.map((emoji) => (
                  <Choice
                    key={emoji}
                    label={emoji}
                    selected={value.image === null && value.symbol === emoji}
                    onSelect={() => choose(emoji)}
                  >
                    <Glyph symbol={emoji} className="size-5" />
                  </Choice>
                ))}
              </Choices>
              <Input
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                  const emoji = lastEmoji(event.target.value);
                  if (emoji) choose(emoji);
                }}
                placeholder={t("anyEmoji")}
                aria-label={t("anyEmoji")}
                className="max-w-56"
              />
            </>
          )}
          {tab === "image" && (
            <div className="flex flex-wrap items-center gap-2">
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
                variant="outline"
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
          )}
        </div>
      </div>
      {value.image === null && (
        <div
          role="radiogroup"
          aria-label={t("agentColor")}
          className="flex flex-wrap items-center gap-1.5"
        >
          <span className="mr-1 text-muted-foreground text-xs">
            {t("agentColor")}
          </span>
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
                "size-6 rounded-full ring-offset-2 ring-offset-background",
                swatch,
                value.color === color
                  ? "ring-2 ring-ring"
                  : "hover:ring-2 hover:ring-border",
              )}
            />
          ))}
        </div>
      )}
    </fieldset>
  );
}

function Choices({ children }: { children: ReactNode }) {
  return (
    <div className="grid w-fit grid-cols-8 gap-1 sm:grid-cols-10">
      {children}
    </div>
  );
}

function Choice({
  label,
  selected,
  onSelect,
  children,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      onClick={onSelect}
      className={cn(
        "flex size-9 items-center justify-center rounded-md border",
        selected
          ? "border-ring bg-accent ring-2 ring-ring/50"
          : "border-transparent hover:bg-accent",
      )}
    >
      {children}
    </button>
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
