// SPDX-License-Identifier: AGPL-3.0-only
/** Content-free, numbered QA progress; totals are never invented. */
export type WorkingPhaseSnapshot = Readonly<{
  phase: string; current: number; total: number | null;
  unit: "messages" | "turns" | "calls" | "chunks" | "tokens";
  status: "running" | "done" | "failed"; elapsed_ms: number;
}>;
const phases: Record<string, readonly [number, string]> = {
  client_prepare: [1, "Anfrage senden"], request_received: [2, "Backend-Vorbereitung"],
  "checkpoint.original_exact_count": [3, "Kontext tokenisieren"],
  "checkpoint.replay_exact_count": [3, "Checkpoint tokenisieren"],
  "checkpoint.reset_exact_count": [3, "Reset tokenisieren"],
  "checkpoint.no_carry_exact_count": [3, "Kontext nachzählen"],
  "conversation_archive.archive_turns": [4, "Archiv vorbereiten"],
  load_branch_positions: [5, "Archivpositionen laden"],
  index_branch_positions: [5, "Archivindex aufbauen"],
  index_live_positions: [5, "Live-Index aufbauen"],
  match_evicted_turn: [6, "Archiv-Turns zuordnen"],
  match_live_turn: [6, "Aktiven Kontext abgleichen"],
  chunk_turn: [7, "Archiv-Chunks erzeugen"],
  embedding_encode: [7, "Embeddings berechnen"],
};
const units: Record<string, string> = {
  messages: "Nachrichten", turns: "Turns", calls: "Aufrufe",
  chunks: "Chunks", tokens: "Tokens",
};
const finite = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
export function formatWorkingPhase(v: WorkingPhaseSnapshot): string {
  const [n, label] = phases[v.phase] ?? [0, "Kontext vorbereiten"];
  const curr = finite(v.current);
  const total = v.total == null ? null : finite(v.total);
  const num = total == null
    ? (curr ? curr.toLocaleString("de-DE") : "")
    : (curr ? curr.toLocaleString("de-DE") + "/" : "") + total.toLocaleString("de-DE");
  const s = Math.floor(finite(v.elapsed_ms) / 1000);
  const time = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  return "Working" + (n ? " " + n : "") + " · " + label +
    (num ? " · " + num + " " + (units[v.unit] ?? "Elemente") : "") + " · " + time;
}
