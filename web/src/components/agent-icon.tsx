import { ImagePlus } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { type TranslationKey, useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import type { Agent } from "~/lib/pim-api";
import { cn } from "~/lib/utils";

/*
 * Agent avatars (see web/DESIGN.md): a flat shape in one saturated color, with
 * two white strokes for eyes. The API keeps the shape as the agent's `symbol`;
 * a symbol from before shapes (an icon's name or an emoji) gets a shape of its own.
 */

/** Each shape: its body, and where its left eye starts. Drawn in a 40×40 box. */
const SHAPES = {
  circle: { body: <circle cx="20" cy="20" r="19" />, eyes: [22, 12] },
  blob: {
    body: (
      <path d="M20 5.5c10.5 0 19.5 5.6 19.5 15S31.5 35 20 35 .5 30 .5 20.5 9.5 5.5 20 5.5z" />
    ),
    eyes: [22, 12.5],
  },
  square: {
    body: <rect x="1.5" y="1.5" width="37" height="37" rx="11" />,
    eyes: [22, 11],
  },
  pill: {
    body: <rect x="0.5" y="8" width="39" height="24" rx="12" />,
    eyes: [22, 13.5],
  },
  triangle: {
    body: (
      <polygon
        points="20,5.5 35.5,33.5 4.5,33.5"
        strokeWidth="7"
        strokeLinejoin="round"
      />
    ),
    eyes: [17.5, 19],
  },
  hexagon: {
    body: (
      <polygon
        points="20,3 34.7,11.5 34.7,28.5 20,37 5.3,28.5 5.3,11.5"
        strokeWidth="5"
        strokeLinejoin="round"
      />
    ),
    eyes: [21, 12.5],
  },
  cloud: {
    body: (
      <>
        <circle cx="11.5" cy="22.5" r="9.5" />
        <circle cx="21" cy="15" r="11.5" />
        <circle cx="30" cy="22.5" r="9.5" />
        <rect x="2" y="20" width="37.5" height="12" rx="6" />
      </>
    ),
    eyes: [20, 12],
  },
  drop: {
    body: (
      <path d="M20 1.5S34.5 16.5 34.5 25a14.5 14.5 0 0 1-29 0C5.5 16.5 20 1.5 20 1.5z" />
    ),
    eyes: [17.5, 20],
  },
} as const satisfies Record<
  string,
  { body: ReactNode; eyes: readonly [number, number] }
>;

export type AgentShape = keyof typeof SHAPES;
const SHAPE_NAMES = Object.keys(SHAPES) as AgentShape[];

const SHAPE_LABELS: Record<AgentShape, TranslationKey> = {
  circle: "shapeCircle",
  blob: "shapeBlob",
  square: "shapeSquare",
  pill: "shapePill",
  triangle: "shapeTriangle",
  hexagon: "shapeHexagon",
  cloud: "shapeCloud",
  drop: "shapeDrop",
};

/** Each color the API accepts, as a fill. Indigo is kept for agents made before brown. */
const COLORS: Record<string, { fill: string; label: TranslationKey }> = {
  brown: { fill: "#8d5b3a", label: "colorBrown" },
  red: { fill: "#ea4335", label: "colorRed" },
  orange: { fill: "#f07a2e", label: "colorOrange" },
  amber: { fill: "#f4a63a", label: "colorAmber" },
  green: { fill: "#3fbf6a", label: "colorGreen" },
  teal: { fill: "#45b5a4", label: "colorTeal" },
  blue: { fill: "#3d84f5", label: "colorBlue" },
  indigo: { fill: "#5b5fe0", label: "colorIndigo" },
  violet: { fill: "#8f5cf2", label: "colorViolet" },
  pink: { fill: "#e9479a", label: "colorPink" },
  gray: { fill: "#767676", label: "colorGray" },
};

/** The colors to choose from; the first, null, is black (white in dark mode). */
const PALETTE = [
  null,
  ...Object.keys(COLORS).filter((color) => color !== "indigo"),
];

const colorLabel = (color: string | null): TranslationKey =>
  (color !== null && COLORS[color]?.label) || "defaultColor";

/** The shape a symbol names; any other symbol always gets the same one. */
export function shapeOf(symbol: string | null): AgentShape {
  if (symbol === null) return "circle";
  if (symbol in SHAPES) return symbol as AgentShape;
  let hash = 0;
  for (const char of symbol)
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
  return SHAPE_NAMES[Math.abs(hash) % SHAPE_NAMES.length] ?? "circle";
}

/** A shape in a color (null: the theme's foreground), with its eyes. `className` sizes it. */
export function Avatar({
  shape,
  color,
  className,
}: {
  shape: AgentShape;
  color: string | null;
  className?: string;
}) {
  const fill = color === null ? undefined : COLORS[color]?.fill;
  const { body, eyes } = SHAPES[shape];
  const [x, y] = eyes;
  return (
    <svg
      viewBox="0 0 40 40"
      className={cn(
        "shrink-0",
        fill === undefined &&
          "fill-primary stroke-primary text-primary-foreground",
        className,
      )}
      style={
        fill === undefined
          ? undefined
          : ({ fill, stroke: fill, color: "#fff" } as CSSProperties)
      }
      aria-hidden="true"
    >
      <g strokeWidth="0">{body}</g>
      <g
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      >
        <path d={`M${x} ${y}l.8 4.6M${x + 6} ${y}l.8 4.6`} />
      </g>
    </svg>
  );
}

/** Pim's own mark: the black circle avatar. */
export function PimMark({ className }: { className?: string }) {
  return <Avatar shape="circle" color={null} className={className} />;
}

type Look = Pick<Agent, "id" | "icon" | "symbol" | "color">;

/**
 * An agent's avatar: its uploaded image, or its shape in its color.
 * `className` sizes it.
 */
export function AgentIcon({
  agent,
  className,
  src,
}: {
  agent: Look;
  className?: string;
  /** An image to show instead, such as one not uploaded yet. */
  src?: string;
}) {
  if (src !== undefined || agent.icon !== null) {
    return (
      <img
        // The version in the URL fetches it again when the icon changes.
        src={src ?? `/api/agents/${agent.id}/icon?v=${agent.icon}`}
        alt=""
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  return (
    <Avatar
      shape={shapeOf(agent.symbol)}
      color={agent.color}
      className={className}
    />
  );
}

/** Where a published template's uploaded icon is, if it has one. */
export const templateIconSrc = (template: Pick<Look, "id" | "icon">) =>
  template.icon === null
    ? undefined
    : `/api/templates/${template.id}/icon?v=${template.icon}`;

/** What the picker changes: the shape and color, and an image to upload, the one saved, or none. */
export type LookChoice = {
  symbol: string | null;
  color: string | null;
  image: Blob | "saved" | null;
};

/** Chooses how an agent looks: a shape and a color, or an uploaded image. */
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
  const shape = shapeOf(value.symbol);
  // Choosing a shape or a color puts it in place of an image.
  const choose = (change: Partial<LookChoice>) =>
    onChange({ ...value, ...change, image: null });

  return (
    <fieldset className="flex flex-col items-center gap-4">
      <legend className="sr-only">{t("agentLook")}</legend>
      <AgentIcon
        agent={shown}
        src={value.image instanceof Blob ? preview : undefined}
        className="size-24"
      />
      <div
        role="radiogroup"
        aria-label={t("agentColor")}
        className="flex flex-wrap justify-center gap-2"
      >
        {PALETTE.map((color) => (
          <button
            key={color ?? "default"}
            type="button"
            role="radio"
            aria-checked={value.image === null && value.color === color}
            aria-label={t(colorLabel(color))}
            title={t(colorLabel(color))}
            onClick={() => choose({ color })}
            className={cn(
              "size-7 rounded-full ring-offset-2 ring-offset-background transition-shadow",
              color === null && "bg-primary",
              value.image === null && value.color === color
                ? "ring-2 ring-link"
                : "hover:ring-2 hover:ring-border",
            )}
            style={
              color === null ? undefined : { background: COLORS[color]?.fill }
            }
          />
        ))}
      </div>
      <div
        role="radiogroup"
        aria-label={t("agentShape")}
        className="flex flex-wrap justify-center gap-1.5"
      >
        {SHAPE_NAMES.map((name) => {
          const selected = value.image === null && shape === name;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={t(SHAPE_LABELS[name])}
              title={t(SHAPE_LABELS[name])}
              onClick={() => choose({ symbol: name })}
              className={cn(
                "flex size-10 items-center justify-center rounded-xl border transition-colors",
                selected
                  ? "border-link ring-2 ring-link/30"
                  : "border-transparent hover:bg-accent",
              )}
            >
              <Avatar shape={name} color={value.color} className="size-7" />
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
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
          variant="ghost"
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
    </fieldset>
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
