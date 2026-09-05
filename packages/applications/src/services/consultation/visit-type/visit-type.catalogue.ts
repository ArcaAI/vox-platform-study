// The VISIT-TYPE VOCABULARY — the platform's two visit types, as pure data and selection.
//
// TASK-882: this used to be "the pure half of `consultation.visitTypes`", a tenant-configurable
// catalogue with a per-task `(task, visitType) -> prompt` binding. The owner's model has no
// tenant-managed conditions (owner #6): the catalogue key, the binding and the write-lane
// validator are gone, and what remains is the vocabulary itself plus the three selections every
// caller needs. A tenant that wants a different prompt per visit type aligns AGENTS by key:value
// tags (TASK-884) — see the seam in `PromptResolutionService.resolve`.
//
// THE VOCABULARY, SETTLED (owner, 2026-08-29):
//
//   "visit-type labels must be easy for user/developer/admins to understand:
//    * new-visit: new patient, new visit, new referral
//    * revisit: here is follow-up or revisit in the same day"
//
// The owner NAMES the first identifier `new-visit`, so the shipped key and
// label are `new-visit` / "New visit" — `new-patient` is an ALIAS. That
// ordering matters: `key` is the persisted, wire-visible id, so retiring it to
// an alias is what keeps every row and caller that already carries it resolving
// onto the same entry (see the alias comment on the default below).
//
// WHAT THIS REPLACED. Visit type was a DERIVED LITERAL in nine places — six
// copies of `consultation.parentConsultationId ? 'revisit': 'new-patient'`, a
// closed TS union on three service/route signatures, and a hand-rolled
// `['new_visit', 'referral']` allow-list in the streaming proxy that returned
// 400 for anything else. It was also INCONSISTENT with itself: the same concept
// was spelled `'new-patient'` where it selected a prompt and `'new-visit'` where
// it filled the `{visit_type}` prompt variable. One vocabulary, here, is what
// fixed that — it is a code constant, not a setting, because it is derived
// state (the parent link), not platform behaviour an admin controls.
//
// WHAT IS *NOT* IN HERE. `'pre-summary'` and `'live'` are PROMPT PHASES, not
// visit types: they select WHICH CHAIN runs, not which encounter this is. The
// resolver already knew that — it computes
// `resolvedCapability: 'pre-summary' | 'live' | 'summary'` from the same
// parameter. They keep travelling in `promptType` (a frozen v1-compat contract,
// and `promptSlotFor` treats them as "no visit-type opinion".

/**
 * Which of `Department`'s two visit-type prompt columns a visit type selects.
 *
 * These two strings are COLUMN NAMES (`newPatientPromptId` / `revisitPromptId`),
 * not catalogue keys, which is why `'new-patient'` survives here after the key
 * of the same spelling was retired. A slot is renamed by a Prisma migration, a
 * key by a data edit; conflating them is how a label change would silently
 * become a schema change.
 */
export type VisitTypePromptSlot = 'new-patient' | 'revisit';

/**
 * One tenant-controlled visit type.
 *
 * `key` is the stable id (what a caller sends and what is persisted onto
 * `GateEditExemplar.visitType`); `label` is what a clinician reads and what
 * fills the `{visit_type}` prompt variable; `aliases` are the inbound
 * wire/EHR spellings that resolve onto it.
 *
 * `promptSlot` is a SCHEMA fact, not a taxonomy: `Department` has exactly two
 * nullable visit-type prompt columns, so every visit type — however many a
 * tenant defines — must say which of the two it reads. Making it explicit is
 * what stops a tenant's third visit type silently inheriting the new-patient
 * prompt, which is a wrong-prompt clinical failure of exactly the kind the
 * pre-summary chain fails closed on.
 */
export interface VisitTypeDefinition {
  key: string;
  label: string;
  aliases: string[];
  promptSlot: VisitTypePromptSlot;
}

/**
 * The two visit types the platform ships — the ONLY two since TASK-882 (see the file header).
 *
 * The aliases are not decoration: every one of them is a visit-type spelling
 * that EXISTED as a literal somewhere in this repo before the catalogue, so a
 * caller that worked yesterday resolves to the same prompt today.
 *
 * ORDER IS THE VALUE. When a consultation records no visit type, the parent
 * link picks a SLOT and the FIRST entry carrying that slot wins — so a tenant
 * makes its own type the default for a branch by putting it first, with no
 * extra field to get wrong.
 */
export const CONSULTATION_VISIT_TYPES_DEFAULT: readonly VisitTypeDefinition[] = Object.freeze([
  Object.freeze({
    key: 'new-visit',
    label: 'New visit',
    // "new patient, new visit, new referral" (owner, 2026-08-29 — `new visit`
    // IS the key) + `new_visit` / `referral` (`text-proxy.controller.ts`).
    //
    // `new-patient` is the RETIRED KEY, kept here for as long as the data
    // outlives it: it is what `GateEditExemplar.visitType` rows written before
    // the rename carry, what the frozen v1-compat lane still emits as a
    // `promptType`, and what any caller integrated against the old catalogue
    // still sends. Dropping it would not fail loudly — `selectVisitType` would
    // fall through to the parent link and silently re-derive a follow-up
    // consultation as `revisit`, relabelling one visit type as the other.
    aliases: Object.freeze(['new-patient', 'new-referral', 'referral']) as unknown as string[],
    promptSlot: 'new-patient',
  }),
  Object.freeze({
    key: 'revisit',
    label: 'Revisit',
    // "follow-up same-day, review same-day, revisit same-day" (owner, row 3)
    // + the `follow-up`/`followup` spellings the v1 wire normalises on + the
    // HYPHENATED `re-visit` the owner wrote in the 2026-08-29 directive
    // ("Follow-up/Re-visit"). That last one did NOT resolve before: the key
    // folds to `revisit`, and nothing folded to `re-visit`, so a term the owner
    // used to NAME this default fell through to the parent-link heuristic.
    aliases: Object.freeze(['follow-up', 'followup', 're-visit', 'follow-up-same-day', 'review-same-day', 'revisit-same-day']) as unknown as string[],
    promptSlot: 'revisit',
  }),
]) as readonly VisitTypeDefinition[];

/**
 * Fold one visit-type spelling onto a comparable token: lower-case, every run
 * of non-alphanumerics to a single `-`, no leading/trailing `-`.
 *
 *   'Follow-Up Same_Day' → 'follow-up-same-day'
 *   'New Visit' → 'new-visit'
 */
export function normalizeVisitTypeToken(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The entry whose key or alias matches `raw`, or `null` when nothing does. */
export function matchVisitType(catalogue: readonly VisitTypeDefinition[], raw: string | null | undefined): VisitTypeDefinition | null {
  const token = normalizeVisitTypeToken(raw);
  if (!token) return null;
  for (const entry of catalogue) {
    if (normalizeVisitTypeToken(entry.key) === token) return entry;
    if (entry.aliases.some((alias) => normalizeVisitTypeToken(alias) === token)) return entry;
  }
  return null;
}

/**
 * THE ONE PLACE the parent-link heuristic lives.
 *
 * It used to be six copy-pasted ternaries. The rule itself is unchanged — a
 * consultation with a `parentConsultationId` is a follow-up — but it is now
 * stated once, and the LABELS it produces come from the tenant's catalogue
 * instead of from a literal at each call site.
 *
 * A recorded visit type that matches NOTHING falls through to the parent link
 * rather than being forced onto a guess: that is the pre-catalogue behaviour of
 * every native (non-compat) path, and inventing a mapping for an unknown string
 * is how one tenant's vocabulary silently selects another's prompt.
 */
export function selectVisitType(
  catalogue: readonly VisitTypeDefinition[],
  input: { recorded?: string | null; isFollowUp: boolean },
): VisitTypeDefinition {
  const recorded = matchVisitType(catalogue, input.recorded);
  if (recorded) return recorded;

  const slot: VisitTypePromptSlot = input.isFollowUp ? 'revisit' : 'new-patient';
  const bySlot = catalogue.find((entry) => entry.promptSlot === slot);
  if (bySlot) return bySlot;

  // Unreachable through the shipped vocabulary (both slots are covered). Kept so
  // this can never return `undefined` on a clinical generation call.
  return catalogue[0] ?? (CONSULTATION_VISIT_TYPES_DEFAULT[0] as VisitTypeDefinition);
}

/**
 * Which `Department` prompt column a `promptType` value reads.
 *
 * `promptType` carries BOTH axes for frozen-contract reasons (so
 * a phase selector (`'pre-summary'`, `'live'`) and an unmatched string both mean
 * "no visit-type opinion" and land on the new-patient column — byte-identical to
 * the ternary this replaces, which also treated everything that was not exactly
 * `'revisit'` as new-patient.
 */
export function promptSlotFor(catalogue: readonly VisitTypeDefinition[], promptType: string | null | undefined): VisitTypePromptSlot {
  return matchVisitType(catalogue, promptType)?.promptSlot ?? 'new-patient';
}
