import { useQuery } from "@tanstack/react-query";
import { majordomoQuery, profileQuery } from "~/lib/queries";

/** The names an agent can mention you by: your username, the name you gave your majordomo and your profile's name. */
export function useUserNames(): string[] {
  const { data: profile } = useQuery(profileQuery());
  const { data: majordomo } = useQuery(majordomoQuery());
  return [
    ...new Set(
      [profile?.username, majordomo?.yourName, profile?.displayName].filter(
        (name): name is string => !!name,
      ),
    ),
  ];
}

/** Whether a text mentions the person, as `@` and any of their names, as the Worker decides it. */
export function mentionsUser(text: string, names: readonly string[]): boolean {
  const keys = names.map((name) => name.toLowerCase()).filter(Boolean);
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/@/g)) {
    if (match.index > 0 && /[\p{L}\p{N}_]/u.test(lower[match.index - 1] ?? ""))
      continue;
    if (
      keys.some(
        (key) =>
          lower.startsWith(key, match.index + 1) &&
          !/[\p{L}\p{N}_]/u.test(lower[match.index + 1 + key.length] ?? ""),
      )
    )
      return true;
  }
  return false;
}
