// The VISIT-TYPE CATALOGUE (`global-kv`) — tenant-admin defined and controlled.
//
// OWNER RULING (TASK-815 §11 row 3): visit type "becomes tenant-configurable
// data with those two seeded defaults — NOT a hardcoded enum, NOT a platform
// constant. Subject to `00-project-context.md` §Configuration Principles:
// tenant → SYSTEM, never a literal in code."
//
// SECOND OWNER DIRECTIVE (2026-08-29): visit type is also "an identifier where
// the hope platform configure and compose the instructions and consultation
// context as prompt for agent to work on: pre-summarization OR summarization OR
// any text generation task." That is what `VisitTypeDefinition.prompts` serves:
// a per-TASK prompt binding hanging off each entry, so `(task, visitType)`
// selects the instructions and the context composition through THIS key's
// cascade. It stayed on this key rather than becoming a second one because the
// binding is meaningless without the visit type it belongs to — one key means
// one write, one audited value, and no way to leave a binding pointing at a
// visit type a later edit deleted.
//
// WHY `global-kv` AND NOT A TABLE. The tier decision turns on what a visit type
// actually IS in this system: a LABEL SET with an alias list, a two-valued
// prompt-column pointer and a sparse task -> template map. It has no relations
// (nothing FKs to it — `GateEditExemplar.visitType`
// is already a bare `String?` facet, and prompt selection is by department
// column), no per-row lifecycle, and it is read on the consultation generation
// hot path from inside BullMQ processors that have no request context.
//
//   • `TenantSettingsService` ALREADY implements exactly the cascade the ruling
//     demands — `tenant override → SYSTEM row → descriptor default`, with the
//     max-scope clamp honoured on READ as well as write, and the two reserved
//     tenants correctly distinguished (the customer tenant `50000000-…` can
//     never appear in it). A table would mean hand-writing that walk again.
//   • Registering a descriptor is the ONLY step needed to make a key governed
//     (09 §Configuration Tiers), so the write lane, the `validate` invariant,
//     `app-settings:invalidate` cache convergence and the settings catalog all
//     arrive with it, and NO migration is involved — which matters here, because
//     the resolution is synchronous and in-memory.
//
// WHAT THAT GIVES UP, stated so the next reader does not have to rediscover it:
// there is no per-entry `_version`/ETag (the catalogue is ONE versioned value,
// so two admins editing different visit types still contend at the list level);
// no `AuditLog` row per visit type (the audit is the GlobalSetting write, which
// records the whole list); no FK integrity, so deleting a type a
// `GateEditExemplar` row already recorded leaves an orphan string in a derived,
// deletable ops projection; and no department/doctor scope. If any of those
// becomes a requirement, the key keeps its name and moves to `db-config` —
// that is what `targetTier` is for. `prompts` sharpens the FK point rather than
// changing it: a binding names a `PromptTemplate` id that nothing enforces, so a
// deleted or never-existent template is caught at RESOLUTION (the tier requires
// an APPROVED template with a snapshot and otherwise falls through) instead of
// at write. That is the same posture the workflow node's own `promptTemplateId`
// binding has, and it is why the tier can only ever ADD a governed prompt.
//
// NOT SEEDED, DELIBERATELY. The two defaults ARE `descriptor.default`, so a
// tenant with no opinion inherits them through the SYSTEM lane's own fallback.
// A seeded `GlobalSetting` row would be a SECOND source of the same truth,
// written once at bootstrap and never re-asserted — `migrate.sh` defaults
// `RUN_SEED=none` and `hope-v2-dev` pins it to `"none"`. That is precisely the
// defect TASK-705 removed from `harness.loop.enabled`; see
// `consultation-gate-seed-parity.test.ts`, which now guards ONE key for that
// reason. A row is warranted only when the intended value DIFFERS from the
// descriptor default, and here it does not.

import {
  CONSULTATION_VISIT_TYPES_DEFAULT,
  CONSULTATION_VISIT_TYPES_KEY,
  visitTypeCatalogueProblem,
} from '../../consultation/visit-type/visit-type.catalogue';
import { SettingDescriptor } from '../registry.types';

export const VISIT_TYPE_SETTINGS: SettingDescriptor[] = [
  {
    key: CONSULTATION_VISIT_TYPES_KEY,
    tier: 'global-kv',
    // An array of objects. `serialize` accepts it (an array IS a non-null
    // object) and `GlobalSettingEntity.parsedValue` round-trips it as JSON.
    dataType: 'json',
    sensitivity: 'internal',
    // TENANT, as the ruling requires. The SYSTEM rows a platform admin writes
    // are the FALLBACK for a tenant with no opinion, never a value that wins
    // over a tenant's own.
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    // A taxonomy, not a selection. Absence must degrade to the two shipped
    // defaults — failing closed would take out prompt resolution, and therefore
    // every consultation, for a value whose absence has an obviously correct
    // answer. Note this is NOT the model/provider-selection case that
    // 09 §Configuration Tiers requires `closed` for: an unresolved
    // catalogue cannot silently become another TENANT's, because the only thing
    // it can fall back to is the platform's own published default.
    failMode: 'open-to-default',
    category: 'Clinical Assurance',
    label: 'Consultation visit types',
    description:
      "The tenant's visit-type catalogue: which encounter kinds exist, what a clinician calls them, which inbound spellings map onto " +
      'them, and which of a Department’s two visit-type prompt columns each one reads. Two defaults ship — New patient (aliases: new ' +
      'visit, new referral) and Revisit (aliases: follow-up / review / revisit same-day) — and a tenant with no catalogue of its own ' +
      'inherits them. ORDER IS THE VALUE: when a consultation records no visit type, its parent link picks a prompt slot and the FIRST ' +
      'entry carrying that slot is used, so a tenant makes its own type the default for a branch by putting it first. `label` is what ' +
      'fills the `{visit_type}` prompt variable. Each entry may also carry `prompts` — a text-generation task key (`summary`, ' +
      '`pre-summary`, `live`, or any task this platform later serves) mapped to `{ promptTemplateId, promptVersionNumber?, ' +
      'contextVariables? }` — which is how a visit type composes its OWN instructions and consultation context for that task instead of ' +
      'borrowing a Department prompt column. A binding is served only when its template is APPROVED; anything else falls through to the ' +
      'existing chain, and a doctor’s preferred template still wins. Resolved per consultation at generation time, so a change applies ' +
      'to the next generation, not retroactively.',
    default: CONSULTATION_VISIT_TYPES_DEFAULT.map((entry) => ({ ...entry, aliases: [...entry.aliases] })),
    validate: visitTypeCatalogueProblem,
  },
];
