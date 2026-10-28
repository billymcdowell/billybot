/** Message content can be a string or a list of parts; this returns the text. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && p.type === "text" ? p.text : "")).join("");
  }
  return "";
}
