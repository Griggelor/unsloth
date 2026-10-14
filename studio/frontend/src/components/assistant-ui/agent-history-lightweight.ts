// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bounded speculative row admission for SIMPLE text chat turns only.
 *
 * Do not treat unmeasured tools/media as lightweight. Inferred complexity is
 * NOT an authoritative DOM measurement; admission is still capped (4 rows),
 * followed by real descendant counting on the first committed render.
 */
export const MAX_UNMEASURED_LIGHT_ROWS = 4;
export function isSimpleTextHistoryRow(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const row = message as {
    role?: unknown; content?: unknown; attachments?: unknown;
    metadata?: unknown;
  };
  if (row.role !== "user" && row.role !== "assistant") return false;
  if (row.attachments != null && (!Array.isArray(row.attachments) || row.attachments.length > 0))
    return false;
  if (row.metadata != null && (typeof row.metadata !== "object" ||
      Object.keys(row.metadata).length > 0)) return false;
  if (!Array.isArray(row.content) || row.content.length !== 1) return false;
  const item = row.content[0];
  if (!item || typeof item !== "object" || item.type !== "text" ||
      typeof item.text !== "string") return false;
  const text = item.text as string;
  if (text.length < 1 || text.length > 160) return false;
  // No Markdown tables, links, code blocks, HTML, LaTeX or multiline items.
  // Lower-risk short single-line messages only. Use Unicode categories to
  // include normal German and international natural-language text.
  return /^[\p{L}\p{N}\p{Zs}.,!?;:'"()\-]+$/u.test(text);
}
