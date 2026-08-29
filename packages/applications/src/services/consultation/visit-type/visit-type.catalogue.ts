// The VISIT-TYPE CATALOGUE — the pure half of `consultation.visitTypes`.
//
// OWNER RULING (TASK-815 §11 row 3, binding): "Visit type is tenant-admin
// defined and controlled. Two defaults ship: New patient (new visit, new
// referral) and Revisit (follow-up same-day, review same-day, revisit
// same-day)."
//
// WHAT THIS REPLACES. Visit type was a DERIVED LITERAL in nine places — six
// copies of `consultation.parentConsultationId ? 'revisit' : 'new-patient'`, a
// closed TS union on three service/route signatures, and a hand-rolled
// `['new_visit', 'referral']` allow-list in the streaming proxy that returned
// 400 for anything else. It was also INCONSISTENT with itself: the same concept
// was spelled `'new-patient'` where it selected a prompt and `'new-visit'` where
// it filled the `{visit_type}` prompt variable. A label set is config
// (`00-project-context.md` §Configuration Principles), so it is data now.
//
// SHAPE — READING (a), FLAGGED FOR OWNER CONFIRMATION. The ruling reads two
// ways: (a) two visit types whose parenthesised terms are SYNONYMS, or (b) two
// GROUPS of three-ish distinct types. This file implements (a), on the evidence
// of the consumers:
//
//   • `text-proxy.controller.ts` already enforced `VisitType = 'new_visit' |
//     'referral'` as ONE axis value — both of the owner's "New patient" terms,
//     collapsed to a single prompt selection.
//   • The v1 wire already carries free-text visit types ('New Referral',
//     'Follow-up', 'Consultation') that the compat layer normalises onto a
//     two-valued selection.
//   • `Department` carries exactly TWO visit-type prompt columns
//     (`newPatientPromptId` / `revisitPromptId`), and TASK-815 DD-2 deliberately
//     parked the whole visit-type axis there.
//
// (a) also SUBSUMES (b): the catalogue is an ordered LIST, so a tenant that
// wants six distinct types simply defines six entries. (b) cannot represent (a)
// without collapsing the aliases. Per the brief's tiebreak — implement the
// reading that can represent the other without a migration — (a) wins.
//
// WHAT IS *NOT* IN HERE. `'pre-summary'` and `'live'` are PROMPT PHASES, not
// visit types: they select WHICH CHAIN runs, not which encounter this is. The
// resolver already knew that — it computes
// `resolvedCapability: 'pre-summary' | 'live' | 'summary'` from the same
// parameter. They keep travelling in `promptType` (a frozen v1-compat contract,
// TASK-815 §2), and `promptSlotFor` treats them as "no visit-type opinion".

/** Which of `Department`'s two visit-type prompt columns a visit type selects. */
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

/** The registry key. `consultation.*`, NOT `agentic.*` — that prefix is a super-admin-only boundary. */
export const CONSULTATION_VISIT_TYPES_KEY = 'consultation.visitTypes';

/**
 * The two defaults the platform ships — the SYSTEM tier's answer for a tenant
 * with no opinion of its own.
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
    key: 'new-patient',
    label: 'New patient',
    // "new visit, new referral" (owner) + `new_visit` / `referral`
    // (`text-proxy.controller.ts`) + `new-visit` (the `{visit_type}` variable).
    aliases: Object.freeze(['new-visit', 'new-referral', 'referral']) as unknown as string[],
    promptSlot: 'new-patient',
  }),
  Object.freeze({
    key: 'revisit',
    label: 'Revisit',
    // "follow-up same-day, review same-day, revisit same-day" (owner) + the
    // `follow-up`/`followup` spellings the v1 wire normalises on.
    aliases: Object.freeze(['follow-up', 'followup', 'follow-up-same-day', 'review-same-day', 'revisit-same-day']) as unknown as string[],
    promptSlot: 'revisit',
  }),
]) as readonly VisitTypeDefinition[];

/**
 * Fold one visit-type spelling onto a comparable token: lower-case, every run
 * of non-alphanumerics to a single `-`, no leading/trailing `-`.
 *
 *   'Follow-Up  Same_Day'  →  'follow-up-same-day'
 *   'New Visit'            →  'new-visit'
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

  // Unreachable through the write lane (`visitTypeCatalogueProblem` refuses a
  // catalogue missing a slot) and through the shipped default. Kept so a
  // catalogue planted by some other path can never return `undefined` on a
  // clinical generation call.
  return catalogue[0] ?? (CONSULTATION_VISIT_TYPES_DEFAULT[0] as VisitTypeDefinition);
}

/**
 * Which `Department` prompt column a `promptType` value reads.
 *
 * `promptType` carries BOTH axes for frozen-contract reasons (TASK-815 §2), so
 * a phase selector (`'pre-summary'`, `'live'`) and an unmatched string both mean
 * "no visit-type opinion" and land on the new-patient column — byte-identical to
 * the ternary this replaces, which also treated everything that was not exactly
 * `'revisit'` as new-patient.
 */
export function promptSlotFor(catalogue: readonly VisitTypeDefinition[], promptType: string | null | undefined): VisitTypePromptSlot {
  return matchVisitType(catalogue, promptType)?.promptSlot ?? 'new-patient';
}

/**
 * The descriptor's declared invariant — what a tenant may NOT save.
 *
 * `dataType: 'json'` establishes only that the value is an object. Everything
 * that makes a catalogue USABLE is a relationship between its entries, which is
 * precisely what a shape check cannot express:
 *
 *   • an EMPTY catalogue leaves every consultation with no visit type at all;
 *   • a DUPLICATE key or a COLLIDING alias makes `matchVisitType` order-dependent,
 *     so which prompt a consultation gets would depend on list position;
 *   • a MISSING slot means a follow-up consultation silently resolves to the
 *     new-patient prompt — a wrong-prompt clinical failure, not a preference.
 *
 * Returns the admin's whole explanation, or nothing to accept.
 */
export function visitTypeCatalogueProblem(value: unknown): string | void {
  if (!Array.isArray(value)) {
    return 'expected an array of visit-type definitions.';
  }
  if (value.length === 0) {
    return 'a tenant must define at least one visit type; an empty catalogue leaves every consultation with no visit type to resolve.';
  }

  const keys = new Set<string>();
  const seen = new Map<string, string>();
  for (const [index, raw] of value.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return `entry ${index} is not an object.`;
    }
    const entry = raw as Partial<VisitTypeDefinition>;
    if (typeof entry.key !== 'string' || normalizeVisitTypeToken(entry.key) === '') {
      return `entry ${index} needs a non-empty 'key'.`;
    }
    if (typeof entry.label !== 'string' || entry.label.trim() === '') {
      return `visit type '${entry.key}' needs a non-empty 'label' — it is what a clinician reads and what fills the {visit_type} prompt variable.`;
    }
    if (entry.promptSlot !== 'new-patient' && entry.promptSlot !== 'revisit') {
      return (
        `visit type '${entry.key}' needs a 'promptSlot' of 'new-patient' or 'revisit' — ` +
        'those are the two visit-type prompt columns a Department actually has, and every visit type must say which one it reads.'
      );
    }
    if (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== 'string')) {
      return `visit type '${entry.key}' needs an 'aliases' array of strings (use [] for none).`;
    }

    const keyToken = normalizeVisitTypeToken(entry.key);
    if (keys.has(keyToken)) {
      return `visit type '${entry.key}' appears more than once — a duplicate key makes which entry answers depend on list order.`;
    }
    keys.add(keyToken);

    // Only a CROSS-ENTRY collision is a problem. An alias that repeats its own
    // entry's key (or another of its own aliases) is redundant, not ambiguous,
    // and refusing it would reject a catalogue that resolves perfectly well.
    for (const token of [keyToken, ...entry.aliases.map(normalizeVisitTypeToken)]) {
      if (token === '') continue;
      const owner = seen.get(token);
      if (owner !== undefined && owner !== entry.key) {
        return `'${token}' is ambiguous — it would collide between visit types '${owner}' and '${entry.key}', so which prompt a consultation gets would depend on list order.`;
      }
      seen.set(token, entry.key);
    }
  }

  const slots = new Set(value.map((entry) => (entry as VisitTypeDefinition).promptSlot));
  for (const slot of ['new-patient', 'revisit'] as const) {
    if (!slots.has(slot)) {
      return (
        `no visit type maps to the '${slot}' prompt slot. ` +
        (slot === 'revisit'
          ? 'A follow-up consultation would then silently resolve to the new-patient prompt.'
          : 'An initial consultation would then have no prompt column to read.')
      );
    }
  }
}
