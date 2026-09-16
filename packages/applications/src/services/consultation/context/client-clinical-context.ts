/**
 * What the CLIENT sent about this patient, read once and rendered for a prompt.
 *
 * A client states `vitals` and `previous_case_notes` at `open`; HOPE validates them against the
 * tenant's own consultation-context schema and persists them as context items keyed by `kindKey`.
 * This module is the ONE place that reads them back and turns them into the two strings a prompt
 * actually carries — the measured readings line and the prior-visit history.
 *
 * ## Why it is a leaf, and must stay one
 *
 * These renderers were born private to the realtime lane
 * (`live-documentation/live-documentation.service.ts`), which is the only surface that had them.
 * Every other prompt the platform composes — the warm-start pre-summary, the authoritative
 * summary, the harness handoff, both job processors, the chain summary — renders the same two
 * names and got `Not available` / `''` for a consultation whose clinic HAD measured and sent the
 * readings. Sharing the functions is the fix, and where they live decides whether it holds:
 * `prompt/live-agent-resolution.service.ts` value-imports `live-documentation.service`, which in
 * turn imports `prompt/pre-summary-variables`, so those two directories are already a cycle. This
 * module therefore imports NEITHER — only `@arcaai/domains` types and the prior-visit bound — and
 * both of those directories import IT.
 *
 * ## Injected decrypt
 *
 * `ContextItem.content` is Vault-Transit ciphertext at rest (the plaintext column was dropped), so
 * a read that skips the decrypt gets an empty body for a row that has one. The decrypt is a
 * CONSTRUCTOR ARGUMENT rather than a `SecretsService` this module resolves for itself: a reader is
 * then usable from a background processor, a request-scoped service and a unit fixture without any
 * of them agreeing on how secrets are wired, and there is exactly one decrypt path to audit —
 * {@link contextItemDecryptor}, which names it.
 *
 * ## Nothing here ever throws
 *
 * A missing repository, an unreadable row, a body that will not decrypt, a payload that is not the
 * declared shape: all of them mean "the client sent nothing", which is the state every
 * consultation opened before the schema existed is in. Raising instead would refuse a clinical
 * note over context that is by definition supplementary.
 */
import type { ContextItemEntity, ContextItemRepository } from '@arcaai/domains';

import { truncatePriorVisitSummary } from '../harness/prior-visit-summary';

/** The kind keys every prompt surface reads. Both are declared by the tenant's scribe schema. */
export const CLIENT_VITALS_KIND_KEY = 'vitals';
export const CLIENT_PREVIOUS_CASE_NOTES_KIND_KEY = 'previous_case_notes';

/**
 * The narrow projection of the client's validated `vitals` object these renderers need.
 *
 * `bloodPressure` is one string because that is how the pair is recorded and read (`128/82`);
 * splitting it into two numbers would invent a precision the source does not have. `temperature`
 * is °C and `oxygenSaturation` a percentage — the units are fixed by the kind's declaration rather
 * than carried per reading, so there is no unit to mis-read at render time.
 *
 * Declared here rather than imported from the schema: the kind's JSON Schema is the contract, and
 * this is what one renderer needs from a payload that has already been validated against it.
 */
export interface ClientVitalsPayload {
  bloodPressure?: string;
  heartRate?: number;
  respiratoryRate?: number;
  temperature?: number;
  oxygenSaturation?: number;
  weightKg?: number;
  heightCm?: number;
  bmi?: number;
  bloodGlucose?: number;
  painScore?: number;
  recordedAt?: string;
  notes?: string;
}

/** One entry of the client-supplied `previous_case_notes` kind. Only `text` is required. */
export interface ClientPreviousCaseNote {
  date?: string;
  department?: string;
  doctor?: string;
  title?: string;
  text?: string;
}

/** What a prompt surface gets back: the two rendered strings, plus the payloads they came from. */
export interface ClientClinicalContext {
  /** The measured readings line, or absent when the client stated no reading. */
  vitals?: string;
  /** The prior-visit history, newest first, or absent when the client stated none. */
  previousVisits?: string;
  raw: {
    vitals?: ClientVitalsPayload;
    previousVisits: readonly ClientPreviousCaseNote[];
  };
}

/** Decrypt one context item's body to plaintext. Injected, never resolved by this module. */
export type ContextItemDecrypt = (entity: ContextItemEntity) => Promise<string | null>;

/** A JSON object — not an array, not null. The shape every declared STRUCTURED kind persists as. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The NEWEST item in `items` carrying this kind key, or `null`.
 *
 * Newest rather than first: a kind declared `ONE` is written once at `open`, but a re-open or a
 * later correction can leave two rows behind, and a prompt must carry what the client last said.
 * The comparison is on `createdAt` rather than on position, so the answer does not depend on the
 * finder's sort staying ascending.
 *
 * Kept as a pure helper beside the repository read: a caller that already holds the consultation's
 * items (or a test that wants to state the ordering rule) must not have to make a second query to
 * apply the same rule.
 */
export function latestContextItemOfKind(items: readonly ContextItemEntity[], kindKey: string): ContextItemEntity | null {
  let latest: ContextItemEntity | null = null;
  for (const item of items) {
    if (item.kindKey !== kindKey) continue;
    if (!latest || item.createdAt >= latest.createdAt) latest = item;
  }
  return latest;
}

/**
 * Render a CLIENT-supplied vitals object as one prompt line, or `undefined` when it states nothing.
 *
 * `undefined` rather than `''` so the caller falls through to the next source, and finally to the
 * DECLARED absence value (`Not available`), instead of handing the model a blank where a reading
 * belongs.
 *
 * Why this outranks vitals a session's NLP tool extracted from speech: the tool output is a model's
 * reading of a conversation; this object is the reading itself. A measured value is not a competing
 * opinion to a transcribed one, it is the fact the transcription is at best an echo of.
 *
 * `recordedAt` rides on the same line rather than being dropped, because a vitals set with no time
 * reads as "now" to a model and a set taken at triage two hours earlier is a different clinical
 * statement. `notes` takes a second line: free text of unbounded length folded into the reading
 * list would make the readings unparsable by eye.
 */
export function formatClientVitalsForPrompt(vitals: ClientVitalsPayload | undefined): string | undefined {
  if (!vitals) return undefined;
  const parts: string[] = [];
  const bp = vitals.bloodPressure?.trim();
  if (bp) parts.push(`BP ${bp} mmHg`);
  if (vitals.heartRate != null) parts.push(`HR ${vitals.heartRate} bpm`);
  if (vitals.respiratoryRate != null) parts.push(`RR ${vitals.respiratoryRate} /min`);
  if (vitals.temperature != null) parts.push(`Temp ${vitals.temperature} °C`);
  if (vitals.oxygenSaturation != null) parts.push(`SpO2 ${vitals.oxygenSaturation} %`);
  if (vitals.weightKg != null) parts.push(`Wt ${vitals.weightKg} kg`);
  if (vitals.heightCm != null) parts.push(`Ht ${vitals.heightCm} cm`);
  if (vitals.bmi != null) parts.push(`BMI ${vitals.bmi}`);
  if (vitals.bloodGlucose != null) parts.push(`Glucose ${vitals.bloodGlucose} mg/dL`);
  if (vitals.painScore != null) parts.push(`Pain ${vitals.painScore}/10`);

  // A `recordedAt` (or a note) with NO readings states nothing about the patient: emitting
  // `recorded 09:40` on its own would tell the model a vitals set exists when none was sent.
  if (parts.length === 0) return undefined;

  const notes = vitals.notes?.trim();
  const recordedAt = vitals.recordedAt?.trim();
  if (recordedAt) parts.push(`recorded ${recordedAt}`);
  const line = parts.join(' · ');
  return notes ? `${line}\n${notes}` : line;
}

/**
 * Render the CLIENT-supplied previous case notes as the prior-visit history, or `''` when empty.
 *
 * `''` rather than `undefined`, because that is the value the workflow's own trigger-context schema
 * declares for this name: an absent history and a supplied-but-empty one are the same statement to
 * a prompt — "no prior visits to report" — never a missing variable an agent would fail closed on.
 *
 * ## Ordering
 *
 * Most recent first, so a prompt that runs out of budget loses the oldest visit rather than the
 * last one. The sort applies only to notes whose `date` actually PARSES: a free-text date ("last
 * monsoon") is not evidence of position, so those keep the order the client sent them in and fall
 * after the dated ones. `Array.prototype.sort` is stable, which is what makes that second half a
 * statement rather than an accident.
 *
 * ## Bounding
 *
 * Through the SAME {@link truncatePriorVisitSummary} the carried prior-visit summary uses, marker
 * and all — a truncated history must not read as a complete one. Whole notes are not dropped to
 * fit: cutting mid-note leaves the marker visible, whereas silently omitting a visit would make the
 * history look shorter than it is.
 */
export function formatPreviousVisitsForPrompt(notes: readonly ClientPreviousCaseNote[] | undefined): string {
  if (!notes || notes.length === 0) return '';

  const dated = notes.map((note, index) => {
    const parsed = note.date ? Date.parse(note.date) : Number.NaN;
    return { note, index, at: Number.isNaN(parsed) ? null : parsed };
  });
  dated.sort((a, b) => {
    if (a.at === null && b.at === null) return a.index - b.index;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at - a.at;
  });

  const rendered = dated
    .map(({ note }) => {
      const heading = [note.date, note.department, note.doctor, note.title].map((part) => part?.trim()).filter((part): part is string => !!part);
      const text = note.text?.trim() ?? '';
      if (!text) return '';
      return heading.length > 0 ? `${heading.join(' · ')}\n${text}` : text;
    })
    .filter((entry) => entry.length > 0);

  return rendered.length > 0 ? truncatePriorVisitSummary(rendered.join('\n\n')) : '';
}

/**
 * Every string the open-time materializer writes into a `CASE_NOTE` row for these notes.
 *
 * A kind marked `materializeAs: 'CASE_NOTE'` is persisted TWICE: once as the STRUCTURED item this
 * module reads, and once as one `CASE_NOTE` per entry, rendered `title\ntext` (or bare `text` when
 * the entry has no title). Both renderings are produced here so a prompt that already carries the
 * history as prior-visit context can recognise — and drop — the case-note copies of the same text,
 * instead of showing the model each note twice under two different headings.
 *
 * Both spellings are emitted for every entry rather than only the one the materializer would have
 * chosen, because whether a title was present is the writer's decision and this is a reader.
 */
export function clientCaseNoteRenderings(notes: readonly ClientPreviousCaseNote[] | undefined): Set<string> {
  const renderings = new Set<string>();
  for (const note of notes ?? []) {
    const text = note.text?.trim();
    if (!text) continue;
    renderings.add(text);
    const title = note.title?.trim();
    if (title) renderings.add(`${title}\n${text}`);
  }
  return renderings;
}

/**
 * The ONE decrypt path for a context item body: the repository's own Vault-Transit read.
 *
 * Without a `SecretsService` the entity's transient `content` — already populated by the
 * process-wide decrypt-on-read wrap when Vault mode is wired, and plain text in env-mode dev and in
 * fixtures — is returned as-is rather than throwing, mirroring the soft no-op the write-side PHI
 * guard takes on the same configuration.
 */
export function contextItemDecryptor(
  repository: ContextItemRepository,
  // The SecretsService shape this crosses is the domains encryption extension's own
  // `SecretsServiceLike`; taken from the repository method's own signature so this leaf never
  // imports a Nest provider of its own.
  secrets: Parameters<ContextItemRepository['decryptContentFromEntity']>[1] | undefined,
): ContextItemDecrypt {
  return async (entity) => {
    if (secrets && entity.encryptedContent) return repository.decryptContentFromEntity(entity, secrets);
    return entity.content ?? null;
  };
}

/**
 * A reader wired the way every application service wires one: the repository it already injects,
 * decrypting through {@link contextItemDecryptor}.
 *
 * Six services compose this identically, and the two lines are exactly where a call site could
 * drift into reading ciphertext as text. Callers build one PER OPERATION, so the memo below is
 * scoped to that operation rather than accumulating consultations on a boot-time singleton; the
 * realtime lane is the exception and holds one for the life of a session, which is what the memo
 * is for.
 */
export function clientClinicalContextReaderFor(
  repository: ContextItemRepository | undefined,
  secrets: Parameters<ContextItemRepository['decryptContentFromEntity']>[1] | undefined,
): ClientClinicalContextReader {
  return new ClientClinicalContextReader(repository, repository ? contextItemDecryptor(repository, secrets) : async () => null);
}

/**
 * Reads the client's clinical kinds for a consultation, at most once each.
 *
 * Memoised through a promise rather than a boolean-plus-value, so two callers racing the first
 * resolution share one read; the rows are written at `open` and cannot change for the life of the
 * consultation, which is what makes caching them correct rather than merely cheap. The memo lives
 * on the READER, so its lifetime is the caller's: a per-request reader caches for that request, and
 * a surface that flushes every few seconds (the realtime lane) holds one for the session.
 */
export class ClientClinicalContextReader {
  private readonly inFlight = new Map<string, Promise<ClientClinicalContext>>();

  constructor(
    private readonly repository: ContextItemRepository | undefined,
    private readonly decrypt: ContextItemDecrypt,
  ) {}

  read(consultationId: string): Promise<ClientClinicalContext> {
    let pending = this.inFlight.get(consultationId);
    if (!pending) {
      pending = this.load(consultationId);
      this.inFlight.set(consultationId, pending);
    }
    return pending;
  }

  private async load(consultationId: string): Promise<ClientClinicalContext> {
    const none: ClientClinicalContext = { raw: { previousVisits: [] } };
    if (!this.repository?.findLatestByKindKey) return none;

    try {
      const [vitalsItem, notesItem] = await Promise.all([
        this.repository.findLatestByKindKey(consultationId, CLIENT_VITALS_KIND_KEY),
        this.repository.findLatestByKindKey(consultationId, CLIENT_PREVIOUS_CASE_NOTES_KIND_KEY),
      ]);
      const [vitalsPayload, notesPayload] = await Promise.all([this.payloadOf(vitalsItem), this.payloadOf(notesItem)]);

      const rawVitals = vitalsPayload ? (vitalsPayload as ClientVitalsPayload) : undefined;
      const rawNotes = notesPayload?.notes;
      const previousVisits = Array.isArray(rawNotes) ? (rawNotes.filter(isPlainRecord) as ClientPreviousCaseNote[]) : [];

      const formattedVitals = formatClientVitalsForPrompt(rawVitals);
      const formattedVisits = formatPreviousVisitsForPrompt(previousVisits);

      return {
        ...(formattedVitals ? { vitals: formattedVitals } : {}),
        ...(formattedVisits ? { previousVisits: formattedVisits } : {}),
        raw: { ...(rawVitals ? { vitals: rawVitals } : {}), previousVisits },
      };
    } catch {
      // PHI-safe by construction: nothing about the failure is carried, and the caller's own
      // logger — which knows the consultation — reports the degrade where it means something.
      return none;
    }
  }

  /** One context item's body as the object it was persisted as, or `null`. */
  private async payloadOf(entity: ContextItemEntity | null): Promise<Record<string, unknown> | null> {
    if (!entity) return null;

    let raw: string | null;
    try {
      raw = await this.decrypt(entity);
    } catch {
      return null;
    }
    if (!raw?.trim()) return null;

    try {
      const parsed: unknown = JSON.parse(raw);
      return isPlainRecord(parsed) ? parsed : null;
    } catch {
      // A body that is not the JSON the kind declares is not a crash.
      return null;
    }
  }
}
