import { Bot } from "lucide-react";
import type { Persona } from "~/lib/pim-api";
import { cn } from "~/lib/utils";

/** A Pim's icon, or a robot when it has none. `className` sizes it. */
export function PimIcon({
  persona,
  className,
}: {
  persona: Pick<Persona, "id" | "icon">;
  className?: string;
}) {
  if (persona.icon === null) {
    return <Bot className={cn("shrink-0", className)} aria-hidden="true" />;
  }
  return (
    <img
      // The version in the URL fetches it again when the icon changes.
      src={`/api/personas/${persona.id}/icon?v=${persona.icon}`}
      alt=""
      className={cn("shrink-0 rounded-sm object-cover", className)}
    />
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
