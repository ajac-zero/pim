import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/** One point of a chart, as the interpreter gave it. */
export type ChartPoint = { x: string; y: number };

/** The theme's own colors, a quiet run of the primary for a pie's slices. */
const SLICES = [100, 70, 50, 35, 25, 18].map(
  (percent) => `color-mix(in oklab, var(--primary) ${percent}%, transparent)`,
);

const axis = {
  stroke: "var(--muted-foreground)",
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;

/** The drawn part of a chart block: recharts with the app's tokens, loaded only when a chart is on the page. */
export default function UiChartView({
  kind,
  points,
}: {
  kind: "bar" | "line" | "pie";
  points: readonly ChartPoint[];
}) {
  const data = points.map((point) => ({ ...point }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      {kind === "pie" ? (
        <PieChart>
          <Pie
            data={data}
            dataKey="y"
            nameKey="x"
            innerRadius="45%"
            stroke="var(--background)"
            isAnimationActive={false}
          >
            {data.map((_, index) => (
              <Cell
                // biome-ignore lint/suspicious/noArrayIndexKey: a pie's slices are its order
                key={index}
                fill={SLICES[index % SLICES.length]}
              />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      ) : kind === "line" ? (
        <LineChart data={data}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="x" {...axis} />
          <YAxis width={40} {...axis} />
          <Tooltip />
          <Line
            dataKey="y"
            type="monotone"
            stroke="var(--primary)"
            strokeWidth={2}
            dot={{ r: 3, fill: "var(--primary)" }}
            isAnimationActive={false}
          />
        </LineChart>
      ) : (
        <BarChart data={data}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="x" {...axis} />
          <YAxis width={40} {...axis} />
          <Tooltip cursor={{ fill: "var(--muted)" }} />
          <Bar
            dataKey="y"
            fill="var(--primary)"
            radius={[6, 6, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}
