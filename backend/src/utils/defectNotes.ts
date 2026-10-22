/**
 * Attach working notes and "actioned" state to the faults on /observability.
 *
 * Notes are keyed on (callId, signature), not on the call, because one call can carry several
 * independent faults — a silent call that also misheard a name — and a note written about one
 * must not appear against the other.
 */

export type DefectStatus = 'outstanding' | 'completed' | 'all';

export interface DefectNoteRow {
  callId: string;
  signature: string;
  note: string | null;
  actionedAt: Date | null;
  actionedBy: string | null;
}

const keyOf = (callId: string, signature: string) => `${callId}\u0000${signature}`;

export function mergeDefectNotes<T extends { callId: string; signature: string }>(
  findings: T[],
  notes: DefectNoteRow[],
  status: DefectStatus | undefined,
): (T & {
  note: string | null;
  actionedAt: Date | null;
  actionedBy: string | null;
  actioned: boolean;
})[] {
  if (!Array.isArray(findings)) return [];
  const byKey = new Map<string, DefectNoteRow>();
  for (const n of (Array.isArray(notes) ? notes : [])) {
    if (!n?.callId || !n?.signature) continue;
    byKey.set(keyOf(n.callId, n.signature), n);
  }

  const merged = findings.map((f) => {
    const n = byKey.get(keyOf(f.callId, f.signature));
    return {
      ...f,
      note: n?.note ?? null,
      actionedAt: n?.actionedAt ?? null,
      actionedBy: n?.actionedBy ?? null,
      // A note is a record of what was found out, not a fix. Only the button
      // marks a fault dealt with.
      actioned: Boolean(n?.actionedAt),
    };
  });

  if (status === 'outstanding') return merged.filter((f) => !f.actioned);
  if (status === 'completed') return merged.filter((f) => f.actioned);
  // Anything else, including a typo in the query string, shows everything —
  // an unrecognised filter must never render as a clean board.
  return merged;
}
