export function ciStatus(commit: string, run?: (args: string[]) => string): "success" | "failed" | "pending";
