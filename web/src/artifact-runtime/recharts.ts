/** Charts for JSX artifacts: registers `recharts`, on the React runtime's React. */
import * as Recharts from "recharts";

const scope = globalThis as unknown as {
  __pimModules: Record<string, unknown>;
};
scope.__pimModules.recharts = Recharts;
