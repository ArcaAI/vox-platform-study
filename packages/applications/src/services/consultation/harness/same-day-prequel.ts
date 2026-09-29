/**
 * TASK-1020 — the `same_day_prequel_summary` PRODUCER.
 *
 * A same-day return visit (a morning consultation, then labs, then an afternoon return for the
 * script and plan of care) is a NEW consultation chained to the morning one by
 * `parentConsultationId` (BP-1). The afternoon prompt needs the morning's note as dated, attributed
 * context (BP-6) — and nothing else: a weeks-old prior visit is the carry-forward's business
 * (`prior_visit_summary`, gated by the graph's `carryForward` binding), not a prequel.
 *
 * ## What counts as a prequel
 *
 * The walk goes UP `parentConsultationId`, at most {@link SAME_DAY_PREQUEL_MAX_DEPTH} hops, and
 * collects every ancestor with the SAME patient, the SAME tenant and the SAME `appointmentDate`
 * (date-only; the column is `@db.Date`). It STOPS at the first ancestor that fails any of those:
 * appointment dates only go backwards up a chain, so an earlier day's ancestor means nothing above
 * it can be today's; and a link to another patient is a broken chain whose further ancestors would
 * contaminate the note. A visited-set makes the walk cycle-safe.
 *
 * ## Which note
 *
 * Each ancestor's note is chosen by the SAME authority order the prior-visit carry-forward uses
 * (signed > clinician-modified > raw) through the ONE shared selection,
 * {@link selectAuthoritativeNoteText}. An ancestor with no note yet contributes no block.
 *
 * ## Unconditional, and never throws
 *
 * Produced whenever a same-day ancestor exists — no graph binding gates it (orchestrator decision,
 * TASK-1020): a same-day return is the one case where the earlier note is not "history" but the
 * first half of the same day's care. Everything is best-effort: an unwired reader, a missing or
 * foreign row, or a store error degrades to "no prequel", because context is supplementary and a
 * clinical note must still be produced.
 */
import {
  CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT,
  CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY,
  isValidTimeZone,
} from '../../settings-registry/descriptors/consultation-appointment-day.descriptors';
import { selectAuthoritativeNoteText, type AuthoritativeNoteReader } from './prior-visit-summary';

/** How many ancestors the walk visits at most. */
export const SAME_DAY_PREQUEL_MAX_DEPTH = 5;

/** Cap on each ancestor's note text inside its block. */
export const SAME_DAY_PREQUEL_BLOCK_MAX_CHARS = 6_000;

/** Appended when an ancestor's note is cut at the cap. */
export const SAME_DAY_PREQUEL_TRUNCATION_MARKER = '[truncated]';

/** The fields of a consultation row the walk reads. A `ConsultationEntity` satisfies it. */
export interface SameDayPrequelSubject {
  id: string;
  tenantId?: string | null;
  patientId?: string | null;
  appointmentDate?: Date | string | null;
  parentConsultationId?: string | null;
  status?: string | null;
  createdAt?: Date | string | null;
}

/** The two repository reads the producer needs. Both optional so an unwired caller degrades. */
export interface SameDayPrequelReaders {
  consultationRepository?: { findById(id: string): Promise<unknown> } | null;
  contextItemRepository?: AuthoritativeNoteReader | null;
}

export interface SameDayPrequel {
  /** The rendered blocks, oldest visit first, or `''`. */
  summary: string;
  /** `true` exactly when `summary` is non-empty. */
  hasSameDayPrequel: boolean;
}

const NO_PREQUEL: SameDayPrequel = Object.freeze({ summary: '', hasSameDayPrequel: false });

/** Whether a rendered prequel carries anything. The flag `trigger.context.same_day_prequel` is this. */
export function hasSameDayPrequel(summary: string | null | undefined): boolean {
  return typeof summary === 'string' && summary.trim().length > 0;
}

/** `YYYY-MM-DD` of a date-only value, or `null` when it cannot be read as one. */
function dayOf(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
    if (match) return match[1]!;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/**
 * Locales tried, in order, for a zone's SHORT name. The abbreviation CLDR prints depends on the
 * locale (`Asia/Kolkata` is `IST` only in `en-IN`, `Europe/London` is `BST` only in `en-GB`), so
 * the first locale that yields a NAME rather than a `GMT±h` offset wins; a zone with no common
 * abbreviation keeps the offset, which is unambiguous.
 */
const ZONE_NAME_LOCALES = ['en-US', 'en-IN', 'en-GB'] as const;

/** `HH:MM <zone>` of a timestamp in `timeZone` (e.g. `21:56 IST`), or `null`. */
function localTimeOf(value: Date | string | null | undefined, timeZone: string): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  let rendered: string | null = null;
  for (const locale of ZONE_NAME_LOCALES) {
    const parts = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(date);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
    const zone = part('timeZoneName');
    rendered ??= `${part('hour')}:${part('minute')} ${zone}`;
    if (!/^(GMT|UTC)[+-]/.test(zone)) return `${part('hour')}:${part('minute')} ${zone}`;
  }
  return rendered;
}

/**
 * The zone a same-day prequel states its times in — the tenant's `consultation.appointmentDay.timeZone`
 * (tenant → SYSTEM → `UTC`), the same zone that decides which DAY a visit is on. Never throws: an
 * unwired settings graph, no tenant, a value this runtime cannot resolve, or a failed read all answer
 * the `UTC` default, because a time label must never cost the clinician a note.
 */
export async function resolveSameDayPrequelTimeZone(
  settings: { resolveEffective(key: string, ctx: { tenantId: string }): Promise<{ value: unknown }> } | null | undefined,
  tenantId: string | null | undefined,
): Promise<string> {
  if (!settings || !tenantId) return CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT;
  try {
    const { value } = await settings.resolveEffective(CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY, { tenantId });
    return isValidTimeZone(value) ? value : CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT;
  } catch {
    return CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT;
  }
}

/** Same patient, same tenant, same day — each side must STATE the value; absence is never equality. */
function isSameDaySibling(subject: SameDayPrequelSubject, candidate: SameDayPrequelSubject): boolean {
  if (!subject.patientId || !candidate.patientId || subject.patientId !== candidate.patientId) return false;
  if (subject.tenantId && candidate.tenantId && subject.tenantId !== candidate.tenantId) return false;
  const day = dayOf(subject.appointmentDate);
  return day !== null && day === dayOf(candidate.appointmentDate);
}

function renderBlock(ancestor: SameDayPrequelSubject, note: string, timeZone: string): string {
  const when = localTimeOf(ancestor.createdAt, timeZone) ?? 'time unknown';
  const status = ancestor.status ? String(ancestor.status) : 'unknown';
  const body =
    note.length > SAME_DAY_PREQUEL_BLOCK_MAX_CHARS
      ? `${note.slice(0, SAME_DAY_PREQUEL_BLOCK_MAX_CHARS)}\n${SAME_DAY_PREQUEL_TRUNCATION_MARKER}`
      : note;
  return `### Earlier visit today (${when}, status ${status})\n${body}`;
}

/** Options for {@link resolveSameDayPrequel}. */
export interface SameDayPrequelOptions {
  /** IANA zone each block's time is stated in — see {@link resolveSameDayPrequelTimeZone}. Absent or unresolvable ⇒ `UTC`. */
  timeZone?: string | null;
}

/**
 * The same-day prequel for `subject`: one block per same-day ancestor with a note, oldest first,
 * joined by a blank line — `### Earlier visit today (<HH:MM zone>, status <status>)\n<note>`, the
 * time in `options.timeZone` (the tenant's day zone).
 */
export async function resolveSameDayPrequel(
  readers: SameDayPrequelReaders,
  subject: SameDayPrequelSubject | null | undefined,
  options: SameDayPrequelOptions = {},
): Promise<SameDayPrequel> {
  const consultations = readers.consultationRepository;
  const notes = readers.contextItemRepository;
  if (!subject?.parentConsultationId || !consultations || !notes) return NO_PREQUEL;

  try {
    const ancestors: SameDayPrequelSubject[] = [];
    const visited = new Set<string>([subject.id]);
    let current: SameDayPrequelSubject = subject;
    for (let depth = 0; depth < SAME_DAY_PREQUEL_MAX_DEPTH; depth += 1) {
      const parentId = current.parentConsultationId;
      if (!parentId || visited.has(parentId)) break;
      visited.add(parentId);
      // A deleted parent is filtered out by the soft-delete extension and the repository THROWS —
      // that ends the chain, it does not fail the prompt.
      // swallow-ok: an unreadable ancestor ends the walk; the prequel is supplementary prompt context
      const parent = (await consultations.findById(parentId).catch(() => null)) as SameDayPrequelSubject | null;
      // A row answering for another id (never the subject itself) ends the chain too.
      if (!parent || parent.id === subject.id || !isSameDaySibling(subject, parent)) break;
      ancestors.push(parent);
      current = parent;
    }

    const timeZone = isValidTimeZone(options.timeZone) ? options.timeZone : CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT;
    const blocks: string[] = [];
    // Collected nearest-first; rendered oldest-first so the day reads in order.
    for (const ancestor of ancestors.reverse()) {
      const note = await selectAuthoritativeNoteText(notes, ancestor.id);
      if (note) blocks.push(renderBlock(ancestor, note, timeZone));
    }
    const summary = blocks.join('\n\n');
    return { summary, hasSameDayPrequel: hasSameDayPrequel(summary) };
  } catch {
    // PHI-safe by construction: nothing about the failure is carried. The prompt proceeds without
    // a prequel, which is exactly the state of every consultation that has no same-day ancestor.
    return NO_PREQUEL;
  }
}
