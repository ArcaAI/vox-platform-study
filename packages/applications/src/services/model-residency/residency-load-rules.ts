import { ModelTaskType } from '@arcaai/domains';
import { derivedLocalPath } from '../ai-model/constants';

/**
 * TASK-1055 — the residency load rules that depend on the catalogue ROW alone: which nlp cache a row
 * loads into, and why a row cannot be loaded at all. Pure (no repository, no Nest), so the catalogue
 * view states the same refusal the load-spec builder throws (`residency-load-spec.builder.ts` holds the
 * full derivation order and the run-time halves: reported slots, the `nlp.diagnosis` / `nlp.ner`
 * elections, the stt agent lookup).
 */

export const SEQ_CLS_GUARD = 'nlp_seq_cls_guard';
export const JUDGE_GUARD = 'nlp_judge_guard';
/** nlp caches whose slot needs nothing beyond `{cache, model_path}`. */
const SIMPLE_NLP_CACHES = new Set(['nlp_token_classifier', 'nlp_text_classifier', 'nlp_gliner2_guard', SEQ_CLS_GUARD, JUDGE_GUARD]);
export const SUGGESTER = 'nlp_medical_suggester';
export const ENTAILMENT = 'nlp_entailment_scorer';
/** Every cache `apps/nlp/src/nlp/residency.py#_plan` accepts. */
export const NLP_CACHES = new Set([...SIMPLE_NLP_CACHES, SUGGESTER, ENTAILMENT]);
/** The one judge protocol nlp's `/guard/judge` has a runtime for (`api/v1/rest/guard.py`). */
const NLP_JUDGE_PROTOCOL = 'qwen3guard_native';
/** `/guard/classify` runtimes by `libraryName` (guardrail `external_nlp_client.py`); `gliner2` is matched first. */
const GUARD_CLASSIFY_LIBRARIES: Record<string, string> = { transformers: SEQ_CLS_GUARD };
const ASR_TASK_TYPE = 'AUTOMATIC_SPEECH_RECOGNITION';

export type NlpRow = {
  id: string;
  sourceUri: string;
  taskType?: unknown;
  libraryName?: string | null;
  architecture?: string | null;
  metaData?: unknown;
  bucketPrefix?: string | null;
  primaryObject?: string | null;
};
export const isRec = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The slice of a catalogue row the static rules read. `AiModelEntity` satisfies it. */
export type LoadSpecRow = Omit<NlpRow, 'id' | 'sourceUri'> & { slug?: string; sourceUri?: string };

/**
 * What the row ALONE says about the nlp slot: a cache, a refusal, or "a text classifier — the SYSTEM
 * `nlp.diagnosis` election decides whether it is the suggester". Pure; no repository read.
 */
export type StaticNlpSlot = { cache: string } | { refusal: string; underivable?: true } | { electionDecides: true };

export function staticNlpSlot(row: LoadSpecRow): StaticNlpSlot {
  const ref = row.sourceUri ?? row.slug ?? 'this model';
  const meta = isRec(row.metaData) ? row.metaData : {};
  if (row.libraryName === 'gliner2' || row.architecture === 'gliner2') return { cache: 'nlp_gliner2_guard' };
  if (meta.entailment !== undefined) {
    if (!isRec(meta.entailment)) {
      return {
        refusal: `nlp_entailment_scorer for '${ref}' needs its calibration (AiModel _metadata.entailment), which the catalogue row does not declare; nlp refuses to load the scorer without it.`,
      };
    }
    if (!derivedLocalPath(row as never)) {
      return {
        refusal: `nlp_entailment_scorer for '${ref}' needs the model's local path, and the catalogue row has none (not published to the models bucket); the scorer never auto-downloads.`,
      };
    }
    return { cache: ENTAILMENT };
  }
  if (meta.judge !== undefined) {
    const protocol = isRec(meta.judge) ? meta.judge.protocol : undefined;
    if (protocol === NLP_JUDGE_PROTOCOL) return { cache: JUDGE_GUARD };
    return {
      refusal: `'${ref}' is a guard judge (AiModel _metadata.judge) with protocol '${String(protocol)}', and nlp's /guard/judge runs only '${NLP_JUDGE_PROTOCOL}'; serve it from LM Studio (servedBy lmstudio) or change its protocol.`,
    };
  }
  if (meta.labelTaxonomy !== undefined) {
    const cache = row.libraryName ? GUARD_CLASSIFY_LIBRARIES[row.libraryName] : undefined;
    if (cache) return { cache };
    return {
      refusal: `'${ref}' is a guardrail classifier (AiModel _metadata.labelTaxonomy) on library '${String(row.libraryName)}', and nlp's /guard/classify runs only gliner2 and transformers; nlp would refuse it.`,
    };
  }
  if (row.taskType === ModelTaskType.TOKEN_CLASSIFICATION) return { cache: 'nlp_token_classifier' };
  if (row.taskType === ModelTaskType.TEXT_CLASSIFICATION) return { electionDecides: true };
  return {
    underivable: true,
    refusal: `nlp slot for '${ref}' cannot be derived from its catalogue row (taskType ${String(row.taskType)}); load it once through the serving path so nlp reports its cache.`,
  };
}

/**
 * TASK-1055 — why a catalogue model cannot be loaded from the console, when the ROW alone says so
 * (`null` = nothing static stands in the way; the load may still be refused at run time, e.g. an ASR
 * model no published agent names, or a suggester with no `nlp.ner` election). The same words the
 * builder throws.
 */
export function loadBlockedReasonFor(service: string, row: LoadSpecRow & { taskType?: unknown }): string | null {
  if (service === 'nlp') {
    const slot = staticNlpSlot(row);
    // A row that does not carry `taskType` at all (a partial projection) has not said its slot is underivable.
    if ('underivable' in slot && row.taskType === undefined) return null;
    return 'refusal' in slot ? slot.refusal : null;
  }
  if (service === 'stt' && row.taskType !== undefined && row.taskType !== null && row.taskType !== ASR_TASK_TYPE) {
    return `'${row.slug ?? row.sourceUri}' is a ${String(row.taskType)} stage, not a speech recognition model: stt loads it with the pipeline of the speech-to-text agent that uses it, never on its own. Load that agent's ASR model instead.`;
  }
  return null;
}
