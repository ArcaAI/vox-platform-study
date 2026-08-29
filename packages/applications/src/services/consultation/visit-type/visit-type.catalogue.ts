// The VISIT-TYPE CATALOGUE — the pure half of `consultation.visitTypes`.
//
// OWNER RULING (TASK-815 §11 row 3, binding): "Visit type is tenant-admin
// defined and controlled. Two defaults ship: New patient (new visit, new
// referral) and Revisit (follow-up same-day, review same-day, revisit
// same-day)."
//
// THE VOCABULARY, SETTLED (owner, 2026-08-29 — closes the §16c question):
//
//   "visit-type labels must be easy for user/developer/admins to understand:
//    * new-visit: new patient, new visit, new referral
//    * revisit: here is follow-up or revisit in the same day"
//
// The owner NAMES the first identifier `new-visit`, so the shipped key and
// label are `new-visit` / "New visit" — `new-patient` is now an ALIAS. That
// ordering matters: `key` is the persisted, wire-visible id, so retiring it to
// an alias is what keeps every row and caller that already carries it resolving
// onto the same entry (see the alias comment on the default below).
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
// THE SECOND OWNER DIRECTIVE (2026-08-29, TASK-815 §15e) — visit type is the
// PROMPT-COMPOSITION IDENTIFIER, not a two-column pointer:
//
//   "Visit type is an identifier where the hope platform configure and compose
//    the instructions and consultation context as prompt for agent to work on:
//    pre-summarization OR summarization OR any text generation task."
//
// `promptSlot` could not serve that. It answers ONE question — which of the two
// `Department` columns a visit type reads — for ONE task (finalize). A tenant
// that defined a third visit type had to borrow one of the two slots, and the
// PRE-SUMMARY chain, which the owner names first, had no visit-type axis at all
// (the visit type reached it only as the `{visit_type}` VARIABLE, never as a
// selector).
//
// `prompts` is the generalisation: a per-TASK binding hanging off the visit type
// itself, so `(task, visitType)` selects the instructions AND the context
// composition. It lives on the catalogue entry — rather than in a second
// settings key or on the workflow node — because the owner's sentence makes the
// visit type the IDENTIFIER, and because everything the cascade needs is already
// here: one key, one write lane, one `validate`, one audited value, and a
// binding that cannot outlive the visit type it belongs to.
//
// WHAT IS *NOT* IN HERE. `'pre-summary'` and `'live'` are PROMPT PHASES, not
// visit types: they select WHICH CHAIN runs, not which encounter this is. The
// resolver already knew that — it computes
// `resolvedCapability: 'pre-summary' | 'live' | 'summary'` from the same
// parameter. They keep travelling in `promptType` (a frozen v1-compat contract,
// TASK-815 §2), and `promptSlotFor` treats them as "no visit-type opinion".

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
 * The text-generation tasks the platform SHIPS a chain for. These are
 * `ResolvedPromptConfig.resolvedCapability`'s own three values, deliberately —
 * naming the axis after the resolver's existing vocabulary is what stops a
 * fourth spelling of the same three things appearing.
 *
 * The `prompts` key space is NOT closed to them. "Any text generation task"
 * (owner) means a new task must be CONFIG, not a code change, so an unknown key
 * is accepted and simply never matched by a chain that does not ask for it.
 */
export const VISIT_TYPE_PROMPT_TASKS = Object.freeze(['summary', 'pre-summary', 'live'] as const);

/** One of the shipped tasks, or a tenant's own task key. */
export type VisitTypePromptTask = (typeof VISIT_TYPE_PROMPT_TASKS)[number] | (string & {});

/**
 * What ONE `(task, visitType)` pairing composes.
 *
 * `promptTemplateId` is the INSTRUCTIONS; `contextVariables` is the
 * CONSULTATION-CONTEXT half of the same composition, merged over the
 * department's own `promptConfig.contextVariables` when — and only when — this
 * binding is the one that supplied the prompt. Splitting them (context from one
 * pairing, instructions from another) would compose a prompt no admin ever
 * authored, which is the failure a single binding object rules out by shape.
 *
 * `promptVersionNumber` is the same opt-in pin a workflow generation node
 * carries (DD-11): absent ⇒ the template's `approvedVersionNumber` snapshot,
 * never the mutable content row.
 */
export interface VisitTypePromptBinding {
  promptTemplateId: string;
  promptVersionNumber?: number;
  contextVariables?: Record<string, unknown>;
}

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
  /**
   * `task -> binding` — what this visit type composes for each text-generation
   * task. ABSENT on the shipped default, and that is the safety property: a
   * tenant that has configured nothing resolves exactly as it did before this
   * field existed, on every chain.
   *
   * Task keys are folded with {@link normalizeVisitTypeToken}, so `summary`,
   * `Summary` and `SUMMARY` are one key (and two of them in one entry are
   * refused as ambiguous).
   */
  prompts?: Record<string, VisitTypePromptBinding>;
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
    // "follow-up same-day, review same-day, revisit same-day" (owner, §11 row 3)
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
 * THE (task, visitType) LOOKUP — the one function a text-generation task calls
 * to find what this visit type composes for it.
 *
 * A MISS IS A MISS, never a neighbour's binding. A tenant that bound only
 * `pre-summary` on "Revisit" must not have that body served for a live flush:
 * serving a pre-summary prompt where a note prompt belongs is exactly the
 * wrong-prompt class `PromptResolutionService`'s capability split exists to
 * kill, and a per-task map that fell back across tasks would reintroduce it.
 * The caller falls through its own chain instead.
 */
export function visitTypePromptBinding(entry: VisitTypeDefinition | null | undefined, task: VisitTypePromptTask): VisitTypePromptBinding | null {
  const prompts = entry?.prompts;
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts)) return null;

  const wanted = normalizeVisitTypeToken(task);
  if (!wanted) return null;

  for (const [name, binding] of Object.entries(prompts)) {
    if (normalizeVisitTypeToken(name) !== wanted) continue;
    return binding && typeof binding === 'object' && typeof binding.promptTemplateId === 'string' && binding.promptTemplateId.length > 0
      ? binding
      : null;
  }
  return null;
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

    const promptsProblem = visitTypePromptsProblem(entry.key, (entry as VisitTypeDefinition).prompts);
    if (promptsProblem) return promptsProblem;

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

/**
 * What a tenant may not save INSIDE one visit type's `prompts` map.
 *
 * Split out of {@link visitTypeCatalogueProblem} only so the entry loop stays
 * readable; it is part of the same declared invariant and runs on the same
 * write.
 *
 * The task key space is deliberately OPEN ("any text generation task"), so
 * there is no membership check against {@link VISIT_TYPE_PROMPT_TASKS} — an
 * unrecognised key is a task this platform does not serve YET, not a typo the
 * catalogue can prove. What IS checkable is checked: a key that folds to
 * nothing, two keys that fold onto one token (which would make the served
 * prompt depend on object key order), a binding with no template, a version pin
 * that is not a real version number, and context variables that are not an
 * object.
 */
function visitTypePromptsProblem(visitTypeKey: string, prompts: unknown): string | void {
  if (prompts === undefined || prompts === null) return;
  if (typeof prompts !== 'object' || Array.isArray(prompts)) {
    return `visit type '${visitTypeKey}' has a 'prompts' that is not an object — it maps a text-generation task key to one prompt binding.`;
  }

  const tasks = new Set<string>();
  for (const [rawTask, rawBinding] of Object.entries(prompts as Record<string, unknown>)) {
    const taskToken = normalizeVisitTypeToken(rawTask);
    if (taskToken === '') {
      return `visit type '${visitTypeKey}' has an empty task key in 'prompts'.`;
    }
    if (tasks.has(taskToken)) {
      return `visit type '${visitTypeKey}' names the task '${taskToken}' more than once — which prompt is served would depend on key order.`;
    }
    tasks.add(taskToken);

    if (rawBinding === null || typeof rawBinding !== 'object' || Array.isArray(rawBinding)) {
      return `visit type '${visitTypeKey}' task '${rawTask}' needs a binding object.`;
    }
    const binding = rawBinding as Partial<VisitTypePromptBinding>;

    if (typeof binding.promptTemplateId !== 'string' || binding.promptTemplateId.trim() === '') {
      return `visit type '${visitTypeKey}' task '${rawTask}' needs a non-empty 'promptTemplateId' — the prompt this pairing composes.`;
    }
    if (binding.promptVersionNumber !== undefined) {
      const pin = binding.promptVersionNumber;
      if (typeof pin !== 'number' || !Number.isInteger(pin) || pin < 1) {
        return `visit type '${visitTypeKey}' task '${rawTask}' has a 'promptVersionNumber' that is not a positive integer version.`;
      }
    }
    if (binding.contextVariables !== undefined) {
      const vars = binding.contextVariables;
      if (vars === null || typeof vars !== 'object' || Array.isArray(vars)) {
        return `visit type '${visitTypeKey}' task '${rawTask}' has 'contextVariables' that are not an object.`;
      }
    }
  }
}
