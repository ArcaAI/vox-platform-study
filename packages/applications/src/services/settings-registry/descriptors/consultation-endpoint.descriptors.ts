// the CONSULTATION ENDPOINT SEQUENCE (`global-kv`).
//
// One key: the ORDERED list of actions that runs before a consultation session
// closes. It exists because the list used to be a code literal
// (`loop-config.service.ts`'s `endingActionsBase`) whose only tenant-facing
// control was `neverActions` — a lever that could SUBTRACT and nothing else. An
// admin could delete a step from the sequence that closes a consultation and
// could not reorder it, extend it, or say "capture feedback after finalizing".
//
// Filed in its own descriptor file rather than appended to
// `harness-loop.descriptors.ts` for the reason that file's own preamble gives
// about `consultation-gates.descriptors.ts`: that one is the loop's LIFECYCLE
// BOUND, and its whole rationale is about idle silence and pinning. This is the
// endpoint STAGE — different concern, different reader, and folding them
// together would make both documents slightly untrue.
//
// WHY `global-kv` AND NOT A COLUMN. Registering a descriptor is the ONLY step
// needed to make a key governed, readable and writable — there is no per-key
// allow-list (09 Tiers). So the platform order, the per-tenant
// override, the admin write lane, cache invalidation and the settings-catalog
// surface all arrive with the descriptor, and no migration is involved. A
// `DepartmentAgent.endpointActions` column would have bought a third cascade
// level nobody asked for at the price of a schema change.

import {
  CONSULTATION_ENDPOINT_ACTIONS_DEFAULT,
  CONSULTATION_ENDPOINT_ACTIONS_KEY,
  endpointOrderProblem,
} from '../../consultation/loop/endpoint-sequence';
import { SettingDescriptor } from '../registry.types';

export const CONSULTATION_ENDPOINT_SETTINGS: SettingDescriptor[] = [
  {
    key: CONSULTATION_ENDPOINT_ACTIONS_KEY,
    tier: 'global-kv',
    dataType: 'string[]',
    sensitivity: 'internal',
    // TENANT, deliberately. The endpoint stage is where a tenant's own
    // compliance posture shows up — whether they capture clinician feedback at
    // the close, whether they lock documents at all — and a platform-only knob
    // would put that decision in the wrong hands. The idle BOUND next door stays
    // `system`, because how long the platform waits is a platform matter.
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    // A tuning knob, not a selection. An absent row must degrade to the code
    // default (the full ordered stage), never raise: failing closed here would
    // take out loop-config resolution — and therefore every consultation — for a
    // value whose absence has an obviously correct answer.
    //
    // Note what "the default" is chosen to be. It is the FULL stage, not an
    // empty one, because "nobody has configured this" must never mean "close
    // consultations without finalizing them". An admin who genuinely wants an
    // empty stage says so through the agent's `neverActions`, which is an
    // explicit act with an audit trail.
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Consultation endpoint sequence',
    description:
      'The ORDERED list of actions ConsultationLoopWorkflow runs before a consultation closes. Order is the value: `livedoc.stop` closes the audio session first, `session.timeout` stamps HOW the session ended, `harness.finalize` produces the note, `summary.finalize` LOCKS every document of the consultation (not just the SOAP note), and `feedback.capture` runs last so a feedback failure can never cost a clinician their finalized note. Only these five keys are accepted. A department agent may EXTEND this list through `alwaysActions` and still veto an entry through `neverActions`; the list itself is what sets the order. Resolved when the loop config is PINNED at workflow start and frozen for the whole consultation, so a change applies to consultations that start after it.',
    default: [...CONSULTATION_ENDPOINT_ACTIONS_DEFAULT],
    // The one ORDER an admin may not save. `dataType: 'string[]'` accepts the five keys in any
    // arrangement, including `summary.finalize` before `harness.finalize` — which locks every
    // document of the consultation and only then tries to write the note into it, i.e. closes the
    // consultation on an empty record. That is not a preference an admin can be assumed to have
    // meant, so the write lane refuses it and says why.
    //
    // Conditional, not a fixed template: removing `harness.finalize` altogether stays legal
    // (see `endpointOrderProblem`), because a tenant relying on the realtime lane's section
    // writes is entitled to that shape.
    validate: endpointOrderProblem,
  },
];
