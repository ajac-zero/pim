/** Icons for JSX artifacts: registers `lucide-react`, on the React runtime's React. */
import * as Lucide from "lucide-react";

const scope = globalThis as unknown as {
  __pimModules: Record<string, unknown>;
};
scope.__pimModules["lucide-react"] = Lucide;
