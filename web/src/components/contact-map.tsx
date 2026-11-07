import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { useI18n } from "~/components/i18n";
import { Plus, X } from "~/components/icons";
import { pim } from "~/lib/pim-api";
import { agentsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** How far apart rings of agents are from the majordomo, and from each other. */
const FIRST_RING = 150;
const RING_GAP = 88;
/** Room each agent takes along its ring, so names don't run into each other. */
const NODE_SPACING = 84;
/** Half of an agent's tile, and of the majordomo's, which is a size larger. */
const NODE_RADIUS = 20;
const CENTER_RADIUS = 26;
/** How much further a line stops below a tile, past the name there. */
const LABEL_CLEARANCE = 20;
/** How far a pointer moves before a press becomes a line being drawn. */
const DRAG_THRESHOLD = 6;

type Point = { x: number; y: number };

/**
 * Saves an agent's contacts as they change, showing the change at once
 * wherever your agents are drawn.
 */
export function useSaveContacts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ from, contacts }: { from: string; contacts: string[] }) =>
      pim.updateAgent(from, { contacts }),
    onMutate: ({ from, contacts }) =>
      queryClient.setQueryData(agentsQuery().queryKey, (all) =>
        all?.map((other) =>
          other.id === from ? { ...other, contacts } : other,
        ),
      ),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });
}

/**
 * Your agents as one map, the majordomo in the middle with a spoke to each of
 * them, since it hands tasks to all of them. Choosing an agent brings out its
 * lines and the agents at their other ends, and greys out the rest. A line
 * drawn from one agent to another makes the second a contact of the first,
 * and a line clicked away takes it off; with an agent chosen, a + or × on
 * each other agent does the same from the keyboard. Each change saves as it
 * is made.
 */
export function ContactMap({
  selected,
  onSelect,
}: {
  /** The agent chosen, whose lines stand out, or null for none. */
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const { data: agents = [] } = useQuery(agentsQuery());
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  // A line being drawn from an agent, to the pointer.
  const [drawing, setDrawing] = useState<{
    from: string;
    start: Point;
    to: Point;
    moved: boolean;
  } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredLine, setHoveredLine] = useState<string | null>(null);
  // The same line, for the pointer's handlers, which may run before it renders.
  const drawn = useRef(drawing);
  const draw = (line: typeof drawing) => {
    drawn.current = line;
    setDrawing(line);
  };
  // A press that drew a line isn't also a click.
  const drew = useRef(false);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const save = useSaveContacts();
  const majordomo = agents.find((other) => other.majordomo);
  const others = agents.filter((other) => !other.majordomo);
  const byId = new Map(agents.map((other) => [other.id, other]));
  const chosen = selected ? byId.get(selected) : undefined;
  const focus = chosen && !chosen.majordomo ? chosen.id : null;
  const { positions, height } = layout(
    width,
    majordomo?.id,
    others.map((other) => other.id),
  );
  const connected = (from: string, to: string) =>
    byId.get(from)?.contacts.includes(to) ?? false;
  const toggle = (from: string, to: string) => {
    const source = byId.get(from);
    const target = byId.get(to);
    if (!source || !target || from === to) return;
    if (source.majordomo || target.majordomo) return;
    save.mutate({
      from,
      contacts: source.contacts.includes(to)
        ? source.contacts.filter((id) => id !== to)
        : [...source.contacts, to],
    });
  };
  // The chosen agent and those it hands tasks to or takes them from stay clear.
  const near = (id: string) =>
    !focus ||
    id === focus ||
    connected(focus, id) ||
    connected(id, focus) ||
    byId.get(id)?.majordomo === true;

  // While a line is drawn, the pointer is followed wherever it goes.
  const active = drawing !== null;
  useEffect(() => {
    if (!active) return;
    const at = (event: PointerEvent): Point => {
      const rect = box.current?.getBoundingClientRect();
      return {
        x: event.clientX - (rect?.left ?? 0),
        y: event.clientY - (rect?.top ?? 0),
      };
    };
    const move = (event: PointerEvent) => {
      const line = drawn.current;
      if (!line) return;
      const to = at(event);
      setHovered(agentAt(event));
      draw({
        ...line,
        to,
        moved:
          line.moved ||
          Math.hypot(to.x - line.start.x, to.y - line.start.y) > DRAG_THRESHOLD,
      });
    };
    const up = (event: PointerEvent) => {
      const line = drawn.current;
      if (line?.moved) {
        drew.current = true;
        const target = agentAt(event);
        if (target && target !== line.from) {
          toggle(line.from, target);
          onSelect(line.from);
        }
      }
      draw(null);
      setHovered(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    // Subscribed again each render, so letting go reads the line and the agents as they are.
  });

  const press = (id: string, event: ReactPointerEvent) => {
    if (event.button !== 0 || byId.get(id)?.majordomo) return;
    const center = positions.get(id);
    if (!center) return;
    drew.current = false;
    draw({ from: id, start: center, to: center, moved: false });
  };
  const choose = (id: string) => {
    if (drew.current) {
      drew.current = false;
      return;
    }
    onSelect(id === focus ? null : id);
  };

  // The line being drawn, to the pointer or to the agent under it.
  const from = drawing?.moved ? drawing.from : null;
  const target =
    hovered && from && hovered !== from && !byId.get(hovered)?.majordomo
      ? hovered
      : null;
  const draft =
    from && drawing
      ? {
          start: positions.get(from) as Point,
          end: target ? (positions.get(target) as Point) : drawing.to,
          removes: target ? connected(from, target) : false,
        }
      : null;

  const lines = others.flatMap((source) =>
    source.contacts
      .filter((id) => byId.has(id) && positions.has(id))
      .map((id) => ({ from: source.id, to: id })),
  );
  const name = (id: string) => byId.get(id)?.name ?? "";

  return (
    <div className="space-y-2">
      <div
        ref={box}
        role="group"
        aria-label={t("network")}
        className={cn(
          "relative select-none overflow-hidden rounded-xl border",
          drawing?.moved && "cursor-crosshair",
        )}
        style={{ height }}
        onClick={(event) => {
          if (drew.current) {
            drew.current = false;
            return;
          }
          // A click on the map, away from any agent or line, chooses none.
          if (
            event.target === event.currentTarget ||
            event.target instanceof SVGSVGElement
          )
            onSelect(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && focus) {
            event.stopPropagation();
            onSelect(null);
          }
        }}
      >
        <svg
          width={width}
          height={height}
          className="absolute inset-0"
          aria-hidden="true"
        >
          <defs>
            <Arrow id="contact-arrow" className="fill-muted-foreground/70" />
            <Arrow
              id="contact-arrow-faint"
              className="fill-muted-foreground/25"
            />
            <Arrow id="contact-arrow-own" className="fill-foreground/80" />
            <Arrow id="contact-arrow-remove" className="fill-destructive" />
            <Arrow id="contact-arrow-draft" className="fill-ring" />
          </defs>
          {majordomo &&
            others.map((other) => {
              const center = positions.get(majordomo.id);
              const end = positions.get(other.id);
              if (!center || !end) return null;
              return (
                <path
                  key={other.id}
                  d={curve(center, end, CENTER_RADIUS, NODE_RADIUS, 0)}
                  className="fill-none stroke-border"
                  strokeWidth={1.5}
                  strokeDasharray="2 5"
                  strokeLinecap="round"
                />
              );
            })}
          {lines.map((line) => {
            const key = `${line.from}>${line.to}`;
            const start = positions.get(line.from) as Point;
            const end = positions.get(line.to) as Point;
            const d = curve(start, end, NODE_RADIUS, NODE_RADIUS + 3, 0.14);
            const removing = hoveredLine === key && !drawing;
            const style = removing
              ? "remove"
              : !focus
                ? "plain"
                : line.from === focus || line.to === focus
                  ? "own"
                  : "faint";
            return (
              <g key={key}>
                <path
                  d={d}
                  pathLength={1}
                  className={cn(
                    "contact-line fill-none transition-[stroke] motion-reduce:transition-none",
                    {
                      remove: "stroke-destructive",
                      plain: "stroke-muted-foreground/70",
                      own: "stroke-foreground/80",
                      faint: "stroke-muted-foreground/25",
                    }[style],
                  )}
                  strokeWidth={
                    style === "own" || style === "remove" ? 1.75 : 1.25
                  }
                  strokeLinecap="round"
                  markerEnd={`url(#contact-arrow${style === "plain" ? "" : `-${style}`})`}
                />
                {/* A wider, invisible stroke makes the line easy to hit. */}
                {/* biome-ignore lint/a11y/noStaticElementInteractions: a shortcut for the pointer; the × on a chosen agent's contacts takes a line away from the keyboard. */}
                <path
                  d={d}
                  className="pointer-events-auto cursor-pointer fill-none stroke-transparent"
                  strokeWidth={14}
                  onPointerEnter={() => setHoveredLine(key)}
                  onPointerLeave={() => setHoveredLine(null)}
                  onClick={() => {
                    setHoveredLine(null);
                    toggle(line.from, line.to);
                  }}
                >
                  <title>
                    {t("removeContact", {
                      from: name(line.from),
                      to: name(line.to),
                    })}
                  </title>
                </path>
              </g>
            );
          })}
          {draft && (
            <path
              d={curve(
                draft.start,
                draft.end,
                NODE_RADIUS,
                target ? NODE_RADIUS + 3 : 0,
                target ? 0.14 : 0,
              )}
              className={cn(
                "fill-none",
                draft.removes ? "stroke-destructive" : "stroke-ring",
              )}
              strokeWidth={1.75}
              strokeDasharray="5 4"
              strokeLinecap="round"
              markerEnd={`url(#contact-arrow-${draft.removes ? "remove" : "draft"})`}
            />
          )}
        </svg>
        {agents.map((other) => {
          const center = positions.get(other.id);
          if (!center) return null;
          const isCenter = other.majordomo;
          const radius = isCenter ? CENTER_RADIUS : NODE_RADIUS;
          const contacts = other.contacts.map(name).filter(Boolean);
          const label = isCenter
            ? t("majordomoContacts")
            : contacts.length > 0
              ? t("contactsList", { names: contacts.join(", ") })
              : t("noContactsYet");
          const isTarget = target === other.id;
          const isChosen = focus === other.id || drawing?.from === other.id;
          // With an agent chosen, each other agent can be made its contact, or stop being one.
          const toggleable = focus && !isCenter && other.id !== focus;
          const linked = toggleable && connected(focus, other.id);
          return (
            <div
              key={other.id}
              className="absolute w-[88px]"
              style={{ left: center.x - 44, top: center.y - radius }}
            >
              <button
                type="button"
                data-agent-id={isCenter ? undefined : other.id}
                disabled={isCenter}
                aria-pressed={isCenter ? undefined : focus === other.id}
                aria-label={`${other.name}. ${label}`}
                title={label}
                onPointerDown={(event) => press(other.id, event)}
                onPointerEnter={() => setHovered(other.id)}
                onPointerLeave={() => setHovered(null)}
                onClick={() => choose(other.id)}
                className={cn(
                  "group flex w-full touch-none flex-col items-center gap-1.5 rounded-xl outline-none transition-opacity disabled:cursor-default motion-reduce:transition-none",
                  !isCenter && "cursor-grab active:cursor-grabbing",
                  // Greyed out, but its + stays clear to add it.
                  !near(other.id) && !isTarget && "opacity-40",
                )}
              >
                <span
                  className={cn(
                    "rounded-xl transition-transform group-focus-visible:ring-[3px] group-focus-visible:ring-ring/50 motion-reduce:transition-none",
                    isChosen &&
                      "ring-2 ring-ring ring-offset-2 ring-offset-background",
                    isTarget && "scale-110",
                  )}
                >
                  <AgentIcon
                    agent={other}
                    tile
                    className={cn(
                      "pointer-events-none",
                      isCenter ? "size-13 rounded-2xl" : "size-10 rounded-xl",
                    )}
                  />
                </span>
                <span
                  className={cn(
                    // The canvas's tone behind the name keeps lines from running through it.
                    "max-w-full truncate rounded-full bg-background px-1.5 text-[13px] leading-4",
                    isChosen || isTarget
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {other.name}
                </span>
              </button>
              {toggleable && (
                <button
                  type="button"
                  aria-label={t(linked ? "stopHandingTasks" : "handTasks", {
                    from: name(focus),
                    to: other.name,
                  })}
                  title={t(linked ? "stopHandingTasks" : "handTasks", {
                    from: name(focus),
                    to: other.name,
                  })}
                  onClick={() => toggle(focus, other.id)}
                  className={cn(
                    "absolute top-[-6px] left-[56px] flex size-5 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm ring-1 ring-border transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none",
                    linked && "hover:text-destructive",
                  )}
                >
                  {linked ? (
                    <X className="size-3" />
                  ) : (
                    <Plus className="size-3" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {/* Two lines tall either way, so what follows stays put as it changes. */}
      <p className="min-h-8 text-muted-foreground text-xs" aria-live="polite">
        {others.length < 2
          ? t("noContacts")
          : focus
            ? t("networkChosenHint", { name: name(focus) })
            : t("networkHint")}
      </p>
    </div>
  );
}

/** The agent under the pointer, other than the majordomo. */
function agentAt(event: PointerEvent): string | null {
  const element = document.elementFromPoint(event.clientX, event.clientY);
  return (
    element?.closest<HTMLElement>("[data-agent-id]")?.dataset.agentId ?? null
  );
}

function Arrow({ id, className }: { id: string; className: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX="8"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto"
    >
      <path d="M 0 1 L 9 5 L 0 9 z" className={className} />
    </marker>
  );
}

/**
 * Where each agent sits: the majordomo in the middle, the others on rings
 * around it, as many to a ring as fit, squeezed sideways on a narrow screen.
 */
function layout(
  width: number,
  center: string | undefined,
  ids: string[],
): { positions: Map<string, Point>; height: number } {
  const rings: string[][] = [];
  for (let i = 0, ring = 0; i < ids.length; ring++) {
    const radius = FIRST_RING + ring * RING_GAP;
    const room = Math.max(1, Math.floor((2 * Math.PI * radius) / NODE_SPACING));
    rings.push(ids.slice(i, i + room));
    i += room;
  }
  const outer = FIRST_RING + Math.max(0, rings.length - 1) * RING_GAP;
  const height = rings.length === 0 ? 120 : 2 * outer + 96;
  const middle = { x: width / 2, y: height / 2 - 6 };
  const squeeze = Math.min(1, (width / 2 - 48) / outer);
  const positions = new Map<string, Point>();
  if (center) positions.set(center, middle);
  rings.forEach((ring, index) => {
    const radius = FIRST_RING + index * RING_GAP;
    ring.forEach((id, slot) => {
      // The first agent sits at the top; every other ring is turned half a step.
      const angle =
        -Math.PI / 2 + ((slot + (index % 2) / 2) * 2 * Math.PI) / ring.length;
      positions.set(id, {
        x: middle.x + Math.cos(angle) * radius * squeeze,
        y: middle.y + Math.sin(angle) * radius,
      });
    });
  });
  return { positions, height };
}

/**
 * A line from one agent to another, bowed to one side so two agents that
 * hand each other tasks show two lines, and stopped short of each tile.
 */
function curve(
  start: Point,
  end: Point,
  startGap: number,
  endGap: number,
  bow: number,
): string {
  const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const control = {
    x: (start.x + end.x) / 2 - ((end.y - start.y) / length) * length * bow,
    y: (start.y + end.y) / 2 + ((end.x - start.x) / length) * length * bow,
  };
  const toward = (from: Point, to: Point, gap: number): Point => {
    const distance = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const down = (to.y - from.y) / distance;
    // A line that leaves downward clears the name under the tile too.
    const clear = gap > 0 ? gap + LABEL_CLEARANCE * Math.max(0, down) : 0;
    return {
      x: from.x + ((to.x - from.x) / distance) * clear,
      y: from.y + down * clear,
    };
  };
  const a = toward(start, control, startGap);
  const b = toward(end, control, endGap);
  return `M ${a.x} ${a.y} Q ${control.x} ${control.y} ${b.x} ${b.y}`;
}
