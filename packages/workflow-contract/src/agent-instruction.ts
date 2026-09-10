/**
 * TASK-947 — the SHAPE of a TEXT_GENERATION agent's `instruction`, read in ONE place.
 *
 * Three mutually exclusive forms (OD-2):
 *
 * | Form | Shape |
 * |---|---|
 * | `template`  | `{ promptTemplateId, promptVersionNumber?, variables?, evalGate? }` |
 * | `inline`    | `{ systemPrompt, evalGate? }` |
 * | `composite` | `{ fragments: [{ key, promptTemplateId \| systemPrompt, promptVersionNumber?, when? }], variables?, evalGate? }` |
 *
 * Before this ticket seven call sites read `instruction.promptTemplateId` by hand — publish, the
 * clone's re-pointing, bundle export and import, promotion into SYSTEM, the reference-set seed,
 * the tag-selected prompt tier. With a fragment list, each of them would have to learn the
 * traversal, and the one that forgot a fragment would export a bundle that imports half an
 * agent. So the traversal lives here, once, and the seven sites map over `boundTemplateRefs` /
 * `mapBoundTemplateRefs`.
 *
 * Everything here answers SHAPE, never validity: `agentInstructionForm({ fragments: [] })` is
 * `'composite'`. What is wrong with it is `textGenerationInstructionProblems`'s job
 * (`agent-schemas.ts`), which says so by path. Pure and dependency-free, like the rest of the
 * package; the Python interpreter reads the same JSON and needs no mirror of this module because
 * it only ever reads the COMPILED artifact (`compiledConfig.resolvedPrompt`), never the authored
 * instruction.
 */

/** Upper bound on `fragments.length` — the `core.condition` branch limit, for the same reason. */
export const AGENT_PROMPT_FRAGMENT_MAX = 16;

/** Fragment keys use the branch-handle grammar (`KEY_PATTERN` in `node-config-schemas.ts`). */
export const AGENT_PROMPT_FRAGMENT_KEY_PATTERN = '^[a-z0-9_]{2,48}$';

/** A `when` is authored text; this bounds it the way `overrides.promptVariables` values are bounded. */
export const AGENT_PROMPT_CONDITION_MAX_LENGTH = 2000;

export type AgentInstructionForm = 'template' | 'inline' | 'composite' | 'none';

/** One authored fragment, fields coerced to their declared types (an absent or mistyped field is simply absent). */
export interface AgentPromptFragment {
  readonly key: string;
  readonly promptTemplateId?: string;
  readonly systemPrompt?: string;
  readonly promptVersionNumber?: number;
  readonly when?: string;
}

/** One template the instruction binds, and WHERE — the path is what a finding or a rewrite names. */
export interface BoundTemplateRef {
  /** `instruction` (form 1) or `instruction.fragments[i]` (form 3). */
  readonly path: string;
  readonly templateId: string;
  /** The authored pin, or `null` for "follow the template's approved version". */
  readonly versionNumber: number | null;
  readonly fragmentIndex: number | null;
  readonly fragmentKey: string | null;
}

/** What `mapBoundTemplateRefs`'s callback answers for one ref. */
export interface BoundTemplateRewrite {
  readonly templateId: string;
  /** `null` DELETES the pin (the clone's lineage restarts); `undefined` keeps whatever pin the ref had. */
  readonly versionNumber?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

/** Which of the three forms this instruction has the shape of — `'none'` for anything else. */
export function agentInstructionForm(instruction: unknown): AgentInstructionForm {
  if (!isRecord(instruction)) return 'none';
  if (Array.isArray(instruction.fragments)) return 'composite';
  if (nonEmptyString(instruction.promptTemplateId)) return 'template';
  if (nonEmptyString(instruction.systemPrompt)) return 'inline';
  return 'none';
}

export function isCompositeInstruction(instruction: unknown): boolean {
  return agentInstructionForm(instruction) === 'composite';
}

/** The fragments of a composite instruction, typed; `[]` for the other forms. Non-object entries are dropped. */
export function readPromptFragments(instruction: unknown): AgentPromptFragment[] {
  if (!isRecord(instruction) || !Array.isArray(instruction.fragments)) return [];
  const out: AgentPromptFragment[] = [];
  for (const raw of instruction.fragments) {
    if (!isRecord(raw)) continue;
    const fragment: { -readonly [K in keyof AgentPromptFragment]: AgentPromptFragment[K] } = { key: typeof raw.key === 'string' ? raw.key : '' };
    if (nonEmptyString(raw.promptTemplateId)) fragment.promptTemplateId = raw.promptTemplateId;
    if (nonEmptyString(raw.systemPrompt)) fragment.systemPrompt = raw.systemPrompt;
    if (positiveInteger(raw.promptVersionNumber)) fragment.promptVersionNumber = raw.promptVersionNumber;
    if (typeof raw.when === 'string') fragment.when = raw.when;
    out.push(fragment);
  }
  return out;
}

/** Every template the instruction binds, in authored order, with the path each one sits at. */
export function boundTemplateRefs(instruction: unknown): BoundTemplateRef[] {
  const form = agentInstructionForm(instruction);
  if (form === 'template') {
    const record = instruction as Record<string, unknown>;
    return [
      {
        path: 'instruction',
        templateId: record.promptTemplateId as string,
        versionNumber: positiveInteger(record.promptVersionNumber) ? record.promptVersionNumber : null,
        fragmentIndex: null,
        fragmentKey: null,
      },
    ];
  }
  if (form !== 'composite') return [];
  const refs: BoundTemplateRef[] = [];
  const raws = (instruction as Record<string, unknown>).fragments as unknown[];
  raws.forEach((raw, index) => {
    if (!isRecord(raw) || !nonEmptyString(raw.promptTemplateId)) return;
    refs.push({
      path: `instruction.fragments[${index}]`,
      templateId: raw.promptTemplateId,
      versionNumber: positiveInteger(raw.promptVersionNumber) ? raw.promptVersionNumber : null,
      fragmentIndex: index,
      fragmentKey: typeof raw.key === 'string' ? raw.key : null,
    });
  });
  return refs;
}

/**
 * The template a POINTER-style reader serves (OD-9): the bound template of form 1, or the FIRST
 * UNCONDITIONAL TEMPLATE fragment of form 3. `null` for form 2, for a composite whose template
 * fragments are all conditional, and for anything malformed — the reader falls through.
 *
 * "Unconditional" is `when` absent; an unconditional INLINE fragment ahead of the first template
 * one does not count, because what these readers want is a template ROW to govern, not text.
 */
export function primaryTemplateId(instruction: unknown): string | null {
  const form = agentInstructionForm(instruction);
  if (form === 'template') return (instruction as Record<string, unknown>).promptTemplateId as string;
  if (form !== 'composite') return null;
  const raws = (instruction as Record<string, unknown>).fragments as unknown[];
  for (const raw of raws) {
    if (isRecord(raw) && nonEmptyString(raw.promptTemplateId) && raw.when === undefined) return raw.promptTemplateId;
  }
  return null;
}

/**
 * A NEW instruction with every bound template ref rewritten through `rewrite`. The callback
 * answers `null` to leave a ref untouched. Inline fragments, `variables`, `evalGate` and any
 * other field travel verbatim; the input is never mutated. `null` for a non-object.
 */
export function mapBoundTemplateRefs(
  instruction: unknown,
  rewrite: (ref: BoundTemplateRef) => BoundTemplateRewrite | null,
): Record<string, unknown> | null {
  if (!isRecord(instruction)) return null;
  const form = agentInstructionForm(instruction);
  const next: Record<string, unknown> = { ...instruction };

  if (form === 'template') {
    const [ref] = boundTemplateRefs(instruction);
    const rewritten = ref ? rewrite(ref) : null;
    if (rewritten) applyRewrite(next, rewritten);
    return next;
  }
  if (form !== 'composite') return next;

  const refsByIndex = new Map(boundTemplateRefs(instruction).map((ref) => [ref.fragmentIndex, ref]));
  next.fragments = (instruction.fragments as unknown[]).map((raw, index) => {
    const ref = refsByIndex.get(index);
    if (!ref || !isRecord(raw)) return raw;
    const rewritten = rewrite(ref);
    if (!rewritten) return raw;
    const fragment: Record<string, unknown> = { ...raw };
    applyRewrite(fragment, rewritten);
    return fragment;
  });
  return next;
}

function applyRewrite(target: Record<string, unknown>, rewritten: BoundTemplateRewrite): void {
  target.promptTemplateId = rewritten.templateId;
  if (rewritten.versionNumber === null) delete target.promptVersionNumber;
  else if (rewritten.versionNumber !== undefined) target.promptVersionNumber = rewritten.versionNumber;
}
