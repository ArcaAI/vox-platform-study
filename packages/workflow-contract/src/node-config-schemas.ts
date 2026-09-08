/**
 * `NODE_CONFIG_SCHEMAS` — the per-node-type config JSON Schema (authorable subset,
 * `@arcaai/json-schema-subset`), the piece `node-registry.ts`'s own docstring and
 * both
 * recorded as a real, structural gap: "no delivered node-type descriptor carries a config
 * schema… `WorkflowNodeDescriptor` in `node-registry.ts` likewise carries no schema field."
 *
 * `registry.contract.md`'s own resolution path ("Where does a per-node config schema come
 * from, going forward?") named option 1: " adds a `configSchema` field to
 * `WorkflowNodeDescriptor`/`WorkflowNodeResponse` when it adds real palette node types." That
 * field never landed even after /724/731/734 added the real node types — this module
 * closes exactly that gap, sourcing each schema from the CONTRACT DOCUMENT already committed
 * for it rather than inventing one:
 *
 * Summarization palette (5):
 *   nodes/*.schema.json` — copied verbatim.
 * STT palette (8): *.schema.json`
 *   — copied verbatim.
 * - `noop`/`core.start`/`core.end`: no committed schema document exists, but the ACTUAL
 *   accepted config is small and readable straight off the interpreter activity
 *   (`apps/harness/src/harness/temporal/interpreter/activities.py`) — `interpreter_noop`
 *   reads `config["raise_error"]`/`config["sleep_seconds"]` and nothing else; `core_start`/
 *   `core_end` read no config at all.
 *
 * Consultation palette (16): authored by to close D-9. `node-types.md` named
 *   `contracts/nodes/*.schema.json` files for these and they were never written, so each schema
 *   is derived instead from the two sources that DO exist and are already enforced — the
 *   `DRAFT_CONSULTATION_RULE_SET` fields a published graph must already carry, and the keys each
 *   interpreter activity actually reads off `payload.config`. See the block comment above those
 *   schemas for the full derivation, and `__tests__/node-config-schemas.test.ts`, which asserts
 *   both directions (nothing the validator demands is missing; nothing the runtime honours is
 *   rejected).
 *
 * ONE node type is DELIBERATELY left with no entry (`configSchema: undefined` on the registry
 * descriptor, the posture the whole registry had for every node until this file):
 *
 * - `passthrough` — "echoes its own config back as output" (`activities.py`'s own docstring);
 *   its whole purpose is accepting an arbitrary payload verbatim, so a fixed schema would be
 *   a false constraint, not a documentation of a real one. The inspector's existing raw-JSON
 *   fallback (`registry.contract.md`'s Task 9 discipline) is the CORRECT rendering for this
 *   node, not a gap.
 *
 * Every entry here is asserted against `authorableJsonSchemaProblems` in
 * `__tests__/node-config-schemas.test.ts` — a schema that is not authorable cannot be compiled
 * by the Studio's `toFieldDescriptors` (`apps/admin-console`) either.
 */

export type NodeConfigSchema = Readonly<Record<string, unknown>>;

/**
 * DD-11's prompt binding, as two config keys on the node that carries it.
 *
 * `promptTemplateId` says WHICH template; `promptVersionNumber` is that node's own movable PIN
 * onto one IMMUTABLE version of it. The pin is the whole mechanism that stops an admin editing
 * one shared template on the Prompt-management screen from silently re-prompting every workflow
 * that references it — including published clinical ones.
 *
 * Declared here rather than per-schema because every schema in this module is
 * `additionalProperties: false` AND the Studio inspector builds its form from
 * `Object.entries(schema.properties)` alone. A node type that can carry a binding but does not
 * DECLARE it loses the pin twice over: the value evaluator rejects it, and form generation drops
 * it because no field is ever rendered for it — so a node round-tripped through the authoring UI
 * comes back unpinned. Sharing one frozen object is what stops the seven declaration sites
 * drifting apart into that state one node at a time.
 *
 * `minimum: 1` is not cosmetic: it is the same bound as `readBinding`'s `pinned > 0` guard
 * (`node-prompt-binding.ts`) and as `versionNumber` on the compiled artifact — the normative
 * `compiled-config.schema.json` and both pydantic models (`ge=1`). A pin authorable here that
 * those reject would be a pin the interpreter cannot honour.
 *
 * Deliberately NOT added to any schema's `required`: DD-11 says a generation node MUST reference
 * a prompt, but making the key required HERE would invalidate every graph already published
 * without one. Shape is this module's job; "must reference" is a rule-catalogue job.
 */
const PROMPT_TEMPLATE_ID_PROPERTY = Object.freeze({
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  description: 'DD-11 — the prompt template this node uses.',
});

const PROMPT_VERSION_NUMBER_PROPERTY = Object.freeze({
  type: 'integer',
  minimum: 1,
  description:
    "DD-11 — this node's own pin onto one immutable version of that template. Absent means the node follows the template's approved version.",
});

/**
 * OD-11's EVAL GATE, as one config key on the node that references the template.
 *
 * The gate runs a golden-set eval when a bound prompt template is approved (or
 * its pin re-pointed) and, in `block` mode, refuses the promotion on failure.
 * It used to be discovered through `DepartmentAgent.goldenSetId`; binds
 * it to the NODE that references the template instead, which is the only place
 * the binding is still meaningful once the agent row is gone.
 *
 * It lives in node CONFIG rather than on `WorkflowNodeDescriptor` (which also
 * declares an `evalGate`, added by) because the two answer different
 * questions. A descriptor is one code-owned constant shared by every tenant: it
 * can say "this node TYPE ships with a platform default gate" and nothing more.
 * `goldenSetId` names a row in ONE tenant's data, and OD-11 requires a per-tenant
 * enable/disable — neither of which a shared constant can hold. So the descriptor
 * field is the type-level default and this is the instance-level binding that
 * overrides it; `EvalPromotionGateService` reads instance-first.
 *
 * BOTH sub-fields are `required` on purpose. A gate with no `goldenSetId` gates
 * nothing (the same rule `nodeDescriptorContractProblems` enforces on the
 * descriptor), and a gate with no `enabled` would make a safety control's state
 * a matter of interpretation — disabling it must be an explicit act, which is
 * exactly what OD-11 says.
 *
 * Declared as one shared frozen object, and attached wherever the prompt binding
 * is, for the reason `PROMPT_BINDING_PROPERTIES` gives: every schema here is
 * `additionalProperties: false` and the Studio inspector renders a field per
 * DECLARED property, so an undeclared key is stripped twice over and a node
 * round-tripped through the authoring UI would come back with its gate silently
 * removed.
 */
const EVAL_GATE_PROPERTY = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['goldenSetId', 'enabled'],
  properties: {
    goldenSetId: {
      type: 'string',
      minLength: 1,
      description: 'OD-11 — the golden set this node’s prompt promotions are evaluated against.',
    },
    enabled: {
      type: 'boolean',
      description:
        'OD-11 — the tenant-admin toggle. Disabled means an approval proceeds with a recorded warning, exactly as "no golden set" always did.',
    },
  },
  description: 'OD-11 — the eval gate on this node’s bound prompt template.',
});

const PROMPT_BINDING_PROPERTIES = Object.freeze({
  promptTemplateId: PROMPT_TEMPLATE_ID_PROPERTY,
  promptVersionNumber: PROMPT_VERSION_NUMBER_PROPERTY,
  evalGate: EVAL_GATE_PROPERTY,
});

/**
 * DD-2's DOCUMENT-SHAPE binding, as two config keys on the generation node that carries it.
 *
 * DD-2 is "no runtime shape switching": a generation node binds ONE document shape STATICALLY,
 * here, and it is frozen for the session — there is no selector node, no runtime classification
 * and no eligibility set. `documentTemplateId` says WHICH `DocumentTemplate`;
 * `documentVersionNumber` is that node's own movable PIN onto one IMMUTABLE version of it.
 *
 * The pin is the same mechanism DD-11 uses for prompts, protecting a DIFFERENT thing: the prompt
 * pin stops a shared template silently re-prompting every workflow; this one stops a republished
 * `DocumentTemplate` silently RESTRUCTURING the clinical document a published workflow already
 * produces. Both bounds match the compiled artifact's `versionNumber` (`minimum: 1` on the
 * normative `compiled-config.schema.json`, `ge=1` on both pydantic models) — a pin authorable
 * here that those reject would be a pin the interpreter cannot honour.
 *
 * Declared as one shared frozen object for the same reason `PROMPT_BINDING_PROPERTIES` is: every
 * schema in this module is `additionalProperties: false` AND the Studio inspector builds its form
 * from `Object.entries(schema.properties)` alone, so an UNDECLARED key is stripped twice over and
 * a node round-tripped through the authoring UI comes back with no shape bound at all.
 *
 * Deliberately NOT in any schema's `required`, exactly like the prompt binding: making it
 * required here would invalidate every graph already published without one.
 */
const DOCUMENT_TEMPLATE_ID_PROPERTY = Object.freeze({
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  summary: 'Which document layout this step produces.',
  description: 'DD-2 — the document template whose compiled shape this node produces.',
});

const DOCUMENT_VERSION_NUMBER_PROPERTY = Object.freeze({
  type: 'integer',
  minimum: 1,
  summary: 'Pin one version of that document layout.',
  description:
    "DD-2 — this node's own pin onto one immutable version of that document template. Absent means the node follows the template's current pin.",
});

/**
 * TASK-932 §3.7 — the SLUG form of the same binding, and the one the REALTIME lane actually reads.
 *
 * `realtimeDocumentTemplateSlug` (`realtime-lane.ts`, TASK-891 D7) looks for exactly this key on
 * the frozen lane's summary node and hands it to `resolveForGeneration(tenantId, slug)` — the
 * parameter that method has accepted since it was written and that nothing ever supplied. The
 * reader shipped; the authoring schema did not, and since every schema here is
 * `additionalProperties: false`, a graph carrying the key could not be PUBLISHED at all: the
 * publish gate answered `NODE_CONFIG_SCHEMA: /documentTemplateSlug: property is not declared`.
 * So OD-2's third wire-up was unreachable, not merely unused, and the traced 2026-09-07 session's
 * `templateId: null` had nowhere else to come from.
 *
 * SLUG rather than id, deliberately, and both forms are kept: an id is a ROW REFERENCE and a
 * document template is CONTENT, cloned per tenant with a fresh id (`copyDocumentTemplates`), so a
 * graph that travels between tenants — the reference set, a promotion into SYSTEM — must name the
 * shape by the one identifier its clones share. `documentTemplateId` stays for a node pinned to a
 * specific row inside one tenant.
 *
 * Not `required`, like both properties above: a node that names no shape falls open to the
 * platform SOAP shape, which is what every graph published before this ticket does.
 */
const DOCUMENT_TEMPLATE_SLUG_PROPERTY = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 128,
  summary: 'Which document layout this step produces, by name.',
  description:
    'The `DocumentTemplate.slug` whose compiled shape this node produces, resolved in the REQUEST tenant. Portable across tenants, unlike `documentTemplateId`.',
});

const DOCUMENT_BINDING_PROPERTIES = Object.freeze({
  documentTemplateId: DOCUMENT_TEMPLATE_ID_PROPERTY,
  documentTemplateSlug: DOCUMENT_TEMPLATE_SLUG_PROPERTY,
  documentVersionNumber: DOCUMENT_VERSION_NUMBER_PROPERTY,
});

const PROMPT_TEMPLATE_REF_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/prompt.template_ref.schema.json',
  title: 'prompt.template_ref node config (N-2, safety class: optional)',
  type: 'object',
  additionalProperties: false,
  required: ['promptTemplateId'],
  properties: {
    ...PROMPT_BINDING_PROPERTIES,
    variableBindings: { type: 'object', additionalProperties: { type: 'string', maxLength: 4000 } },
  },
});

const GUARDRAIL_CHECK_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/guardrail.check.schema.json',
  title: 'guardrail.check node config (N-4, safety class: mandatory, non-removable)',
  type: 'object',
  additionalProperties: false,
  required: ['guardrailType', 'failOn', 'onFail'],
  properties: {
    guardrailType: { type: 'string', minLength: 1, maxLength: 64 },
    failOn: { type: 'string', enum: ['unsafe_or_unknown'], default: 'unsafe_or_unknown' },
    // `abort` is DELIBERATELY not offered (closing). The shipped v1
    // interpreter has no mechanism for a per-node CONFIG value to override a CODE-OWNED registry
    // property: `critical` lives on `NODE_REGISTRY` (`guardrail.check` is `critical: false`) and
    // `NodeActivityResult.status` is `Literal['SUCCEEDED','DEGRADED','SKIPPED']` — an activity
    // cannot return `FAILED`, and only the workflow body promotes a degraded CRITICAL node to a
    // run-level failure. So a tenant authoring `onFail: 'abort'` previously got SILENT
    // NON-ENFORCEMENT: the value validated, was recorded on the trajectory, and gated nothing —
    // while the tenant believed they had made that run's guardrail failure fatal. Rejecting the
    // value at authoring time is the honest half of "enforce it or reject it"; same posture as
    // `failOn` above, which is likewise pinned to its one v1-permitted value. Restore `abort`
    // only together with a real promotion mechanism.
    onFail: { type: 'string', enum: ['mark'] },
  },
});

// -----------------------------------------------------------------------------------------
// Consultation palette ( +) — sixteen node types, authored by
// to close D-9.
//
// D-9 is recorded as "13 of 16 `consultation.*` node types have no config schema". The true
// count is SIXTEEN of sixteen: the "13" figure predates, which added
// `realtimeSummary`, `suggestions` and `proposeCorrections`. This module's own docstring above
// still says "`consultation.*` (13 node types)" for the same reason — it was written before
// those three existed.
//
// `node-types.md` named `contracts/nodes/*.schema.json` files for this
// palette and they were never authored, which is why the previous pass declined to invent them.
// They are NOT invented here either: every field below comes from one of two sources that
// already exist and are already enforced, and `__tests__/node-config-schemas.test.ts` asserts
// against both.
//
//   1. `DRAFT_CONSULTATION_RULE_SET` (`rule-catalogue.ts`) — the config fields a published
//      consultation graph is ALREADY required to carry: `occ` (WF-CONS-014), `producesCode`
//      (WF-CONS-015), `purposeScope` (WF-CONS-013), `unmappedOutputKey` (WF-CONS-016),
//      `requiresFinalized` (WF-CONS-017/018) and `onError` on every activity-classed node
//      (WF-CONS-019). A schema omitting any of them would reject graphs the validator demands.
//   2. The interpreter activities — every key each one actually reads off `payload.config`
//      (`apps/harness/src/harness/temporal/interpreter/nodes/consultation*.py`). A schema
//      omitting any of them would reject config the runtime honours.
//
// Two conventions carried from the schemas above rather than reinvented:
//
//   - `onError` is `['degrade', 'retry', 'fail']` — WF-CONS-019's own permitted set, and
//     NOTABLY not `abort`. Same posture as `guardrail.check.onFail`: the v1 interpreter cannot
//     promote a node failure to a run-level abort (`NodeActivityResult.status` has no `FAILED`),
//     so offering the value would be silent non-enforcement. Reject at authoring time instead.
//   - Neither GATE node (`consentGate`, `hitlGate`) declares `onError`. They are the two nodes
//     that are not `activity`-classed, so WF-CONS-019 never fires for them and requiring an error
//     policy would be a constraint nothing enforces. NOTE: `consentGate` takes no config at all,
//     but `hitlGate` DOES — `compileGate` reads four fields off it (see its schema below).
// -----------------------------------------------------------------------------------------

/**
 * WF-CONS-013's `purposeScope` taxonomy (lane A, item 19).
 *
 * ## Why these values and not an invented vocabulary
 *
 * CR-03 states the rule in its own words: *"Every node performing a tool/MCP call MUST declare a
 * purpose scope in its config"*. So `purposeScope` names the PURPOSE OF USE of an outbound call,
 * not a property of the codes that come back — and this platform already has a ratified
 * purpose-of-use vocabulary for exactly that: `ConsentPurpose`
 * (`packages/database/src/prisma/db_main/enums.prisma`, consent-abac). WF-CONS-013's own
 * invariant list cites **INV-007**, which is the same invariant `ConsentPurpose.EXTERNAL_TOOL_LOOKUP`
 * cites — the two are the same concept seen from two sides.
 *
 * The correspondence is not theoretical. `consultation.bindTerminology`'s activity calls
 * `call_mcp_tool`, which performs a consent check with `purpose="EXTERNAL_TOOL_LOOKUP"`
 * (`apps/harness/src/harness/temporal/activities.py:1092`) — a HARDCODED literal today. Declaring
 * the config taxonomy over the same enum is what makes it possible for that literal to become
 * `config.purposeScope` instead, which is the direction `00-project-context.md` §Configuration
 * Principles requires ("a label taxonomy is NOT a literal in code").
 *
 * ## Which members, and which are deliberately absent
 *
 * | Value | Grounding |
 * |---|---|
 * | `EXTERNAL_TOOL_LOOKUP` | `activities.py:1092` — the purpose THIS node's own egress already checks. |
 * | `HISTORY_RETRIEVAL` | `activities.py:1541` — the purpose the platform's other retrieval egress checks. |
 * | `AI_DOCUMENTATION` | `enums.prisma` — "Consultation capture + AI-assisted note generation"; a bind performed purely to code the note being written. |
 * | `QUALITY_REVIEW` | `enums.prisma` — "Downstream quality/metrics review of the encounter". |
 *
 * `STYLE_LEARNING` is the one `ConsentPurpose` member deliberately EXCLUDED: it authorizes a DNA
 * writing-style opt-in, not an outbound tool call, so offering it here would let a node declare a
 * purpose under which its egress could never be granted.
 *
 * ⚠ **Proposed, pending owner confirmation.** left this "an open owner decision"; the
 * set above is derived from real usage rather than supplied, and the two values previously in the
 * tree (`terminology.validate` in the seed, `clinical-coding` in the golden fixtures) were both
 * free strings written before any taxonomy existed. Both are migrated to `EXTERNAL_TOOL_LOOKUP`,
 * which is what their egress actually asks consent for.
 */
export const TERMINOLOGY_PURPOSE_SCOPES = Object.freeze(['EXTERNAL_TOOL_LOOKUP', 'HISTORY_RETRIEVAL', 'AI_DOCUMENTATION', 'QUALITY_REVIEW'] as const);

/** WF-CONS-019's permitted error policies, verbatim. Shared so the rule and the schemas cannot
 *  drift apart silently. */
const CONSULTATION_ON_ERROR = Object.freeze({
  type: 'string',
  enum: Object.freeze(['degrade', 'retry', 'fail']),
  description: 'Node error policy (WF-CONS-019). `abort` is deliberately not offered — the v1 interpreter cannot enforce it.',
});

/** `consultation.consentGate` — its activity reads no `payload.config`
 *  (`nodes/consultation.py:44`), and unlike `hitlGate` it does NOT carry the `gate` class, so the
 *  compiler routes it through `compileNode` rather than `compileGate` and it has no gate config
 *  either. (`compileNode` does read the palette-agnostic `timeoutSeconds`/`retry`/`onError` off
 *  every node — see the ADDENDUM at the foot of this module; that gap is uniform across all 33
 *  node types and is deliberately not patched here one node at a time.) */
const CONSULTATION_CONSENT_GATE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.consentGate node config (none — the gate reads no config)',
  type: 'object',
  additionalProperties: false,
  properties: {},
});

const CONSULTATION_BIND_TERMINOLOGY_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.bindTerminology node config (N-4)',
  type: 'object',
  additionalProperties: false,
  required: ['purposeScope', 'unmappedOutputKey', 'onError'],
  properties: {
    // item 19 — CLOSED. `purposeScope` now draws from `TERMINOLOGY_PURPOSE_SCOPES`
    // above, which is the `ConsentPurpose` purpose-of-use vocabulary restricted to the members
    // that can justify an outbound tool call. WF-CONS-013 still only checks PRESENCE (`op:
    // 'present'`); the enum is what makes the declared purpose comparable with the consent
    // purpose the node's own egress asks for.
    purposeScope: {
      type: 'string',
      enum: TERMINOLOGY_PURPOSE_SCOPES,
      description:
        "WF-CONS-013 — the purpose of use declared for this node's outbound terminology call. Drawn from ConsentPurpose , so it is comparable with the consent grant the egress is checked against.",
    },
    unmappedOutputKey: {
      type: 'string',
      pattern: '^[a-z0-9_]{2,48}$',
      description:
        'WF-CONS-016 — where terms that bound to NO code are surfaced. An unmapped term that is silently dropped is an unmapped term nobody reviews.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_PHI_HOP_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.phiHop node config (N-5, safety class: mandatory, redaction)',
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'onError'],
  properties: {
    // ⚠ DELIBERATELY DIFFERENT from `stt.phiHop`, which is `['pseudonymize', 'full-redact']`.
    // DO NOT "harmonise" these two enums — they are not the same vocabulary, and the difference
    // is load-bearing. The consultation activity guards on its own two values:
    //
    //   `nodes/consultation.py:102` -> `if mode not in ("pseudonymize", "full"):`
    //   `nodes/consultation.py:107` -> DEGRADEs with "config.mode {mode!r} is not
    //                                     'pseudonymize' or 'full'"
    //   `nodes/consultation.py:92` -> docstring: "the same two-mode vocabulary
    //                                     `IPhiRedactor.redact()` uses on the gateway side"
    //
    // This schema drives the Studio inspector, so declaring `full-redact` here offered an admin
    // a value that DEGRADES at runtime while hiding `full`, the only one that actually redacts —
    // a PHI-redaction node silently not redacting is the worst possible shape for this defect.
    mode: { type: 'string', enum: ['pseudonymize', 'full'] },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_RETRIEVE_EVIDENCE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.retrieveEvidence node config (N-6)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    retrievalEnabled: {
      type: 'boolean',
      description: 'Whether evidence retrieval runs at all; false makes the node an observable no-op rather than a silent one.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

/**
 * TASK-882 — the re-visit CARRY-FORWARD decision, as a binding on the node that composes the
 * prompt. It replaces the platform key `agentic.revisit.carryForwardEnabled`: whether a re-visit
 * consultation carries its parent visit's most authoritative summary into the prompt is a
 * property of the workflow that generates the note, so it is authored on the graph the
 * consultation is assigned — the prompt-composition node here, `core.agent.overrides` in the
 * `core` vocabulary — and read by `ConfigResolver.resolveRevisitCarryForwardEnabled`.
 *
 * DEFAULT OFF, and that is a clinical-safety decision rather than caution about the plumbing:
 * carry-forward inherits the copy-paste / cloned-note risk profile (stale or unverified content
 * propagating into a new encounter), so it must be an explicit opt-in per graph.
 */
const CARRY_FORWARD_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'boolean',
  default: false,
  summary: 'Carries the prior visit summary into this prompt for reference.',
  description:
    "Re-visit carry-forward. When true, a consultation with a parent visit carries the parent's most authoritative summary into this prompt as a labeled, non-authoritative prior that must be re-confirmed against the current transcript. Absent is OFF.",
});

/** `consultation.sensors` (deterministic) and `consultation.inferentialSensors` (LLM judge).
 *  Neither activity reads `payload.config` beyond the palette-wide error policy — model and
 *  provider selection is `AiRoutingPolicy`'s (SYSTEM default row), never a node literal
 *  (`consultation_verify.py`'s own docstring makes that explicit). */
const CONSULTATION_SENSORS_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation sensor node config (N-9/N-10 — verification, provider/model resolved by AiRoutingPolicy)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: { onError: CONSULTATION_ON_ERROR },
});

const CONSULTATION_PERSIST_DRAFT_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.persistDraft node config (N-11, safety class: mandatory, externalWrite)',
  type: 'object',
  additionalProperties: false,
  required: ['occ', 'onError'],
  properties: {
    occ: {
      type: 'boolean',
      description:
        'WF-CONS-014 pins this to true — optimistic concurrency on the draft write is the  authorship protection made structural. Without it a background write silently overwrites an in-flight clinician edit.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const CONSULTATION_FINALIZE_ASSURANCE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'consultation.finalizeAssurance node config (N-12, safety class: mandatory, externalWrite)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: { onError: CONSULTATION_ON_ERROR },
});

// -----------------------------------------------------------------------------------------
// W3 — the three live-assist nodes. All three call a language model through
// `apps/text`, so all three expose the same generation knobs; provider and model themselves are
// NEVER node config (SYSTEM `AiRoutingPolicy` default selection, fail-closed).
//
// `responseFormat` is typed as the same string enum the committed `generate.text` schema uses.
// The activities additionally accept a full json-schema OBJECT and fall back to the code-owned
// `SOAP_RESPONSE_FORMAT` (`nodes/_soap.py:76`) when unset — an arbitrary object is not
// expressible in the authorable subset, and the SOAP shape is code-owned rather than tenant
// business, so the enum is the honest authorable surface and the default keeps working.
// -----------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// The ENDPOINT STAGE — the five `trigger: 'on-end'` endpoint node types.
//
// Each schema is deliberately SMALL. The endpoint stage's ORDER is not authored here: since
// TASK-882 it is the EDGE ORDER of the endpoint nodes on the assigned graph (read by
// `LoopConfigService`; the platform default applies when a graph declares none), because the
// order is a property of the chain and not of any one node. What a node's config carries is
// only what THAT node does when its turn comes.
// ---------------------------------------------------------------------------------------------

const SESSION_TIMEOUT_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'session.timeout node config (the endpoint stage owns the idle bound)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    idleTimeoutSeconds: {
      type: 'integer',
      minimum: 0,
      description:
        'Idle SILENCE the loop tolerates before the endpoint sequence runs, in seconds. 0 disables the bound. Absent ⇒ the platform value (`harness.loop.idleTimeoutSeconds`). Every arriving context item restarts it, so this measures silence, not consultation length.',
    },
    runEndpointOnExpiry: {
      type: 'boolean',
      default: true,
      description:
        'Whether expiry runs the rest of the endpoint sequence. Defaults TRUE and should stay true: a timed-out consultation that never finalizes silently loses the encounter (D-12). Set false only to reproduce the pre-existing abandon-on-expiry behaviour.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const SUMMARY_FINALIZE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'summary.finalize node config (DD-3 — locks EVERY document, not just the SOAP note)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    // There is deliberately NO `documentKey` / `documentKeys` property. DD-3 is that finalize
    // locks every document of the consultation; a per-node document selector would be the exact
    // defect it closes — a finalize that locks only the SOAP note leaves a discharge summary
    // editable after signature.
    lockConfirmedOnly: {
      type: 'boolean',
      default: false,
      description:
        'When true, only CONFIRMED sections are locked and PROVISIONAL ones are left writable. Defaults FALSE: a signed encounter freezes whole, including the machine-written sections nobody edited.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const FEEDBACK_CAPTURE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'feedback.capture node config (DD-8 — the ONLY advisory-correction promotion path)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    promoteCorrections: {
      type: 'boolean',
      default: true,
      description:
        'Whether an ACCEPTED advisory correction is promoted onto the transcript. This node is the only path that can (DD-8); turning it off does not move the promotion elsewhere, it removes it.',
    },
    minConfidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Proposals below this confidence are never offered for promotion, even if the payload names them.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

/**
 * TASK-882 — the two endpoint stages that had no node type. `livedoc.stop` closes the live
 * audio session (`persistSnapshot` mirrors the loop's own stop); `harness.finalize` is the
 * position of note generation in the stage — inside an interpreter run it is an ordering marker
 * (the graph IS the document workflow), so it carries nothing but the shared `onError`.
 */
const LIVEDOC_STOP_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'livedoc.stop node config (the endpoint stage closes the live session first)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    persistSnapshot: {
      type: 'boolean',
      default: true,
      description: 'Whether stopping persists the final live snapshot. Defaults TRUE, matching the loop`s own stop.',
    },
    onError: CONSULTATION_ON_ERROR,
  },
});

const HARNESS_FINALIZE_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'harness.finalize node config (the position of note generation in the endpoint stage)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    onError: CONSULTATION_ON_ERROR,
  },
});

// -----------------------------------------------------------------------------------------
// The TARGET CATALOGUE (/DD-9) and the guards — lane A.
//
// Nine `agent.*` entries and three `guard.*` entries. Almost every one of them REUSES the config
// schema of the engine it delegates to, exactly as `consultation.inferentialSensors` already
// reuses `consultation.sensors`' schema: DD-9's instruction is "one implementation behind them —
// do not fork the engine", and a forked SCHEMA is how a forked implementation starts. Only the
// two node types with no existing engine node carry a schema of their own, below.
// -----------------------------------------------------------------------------------------

/**
 * What ONE grounding policy may be pointed at — and it is the node's own evaluation inputs, not
 * an invented clinical vocabulary.
 *
 * `summary` is the required `in: document` socket (the redacted summary), `transcript` and
 * `findings` are the two optional ones added. Deriving the set from the ports is
 * what stops it drifting: a policy can only ever be scoped to something the node can actually be
 * handed, and adding a fourth target means adding a fourth input first.
 *
 * The socket is called `in` rather than `summary` because it predates this addition and renaming
 * a published port is the reshape `schemaVersion` exists to forbid; `summary` is the name an
 * ADMIN reads, which is why the taxonomy uses it and the port table does not.
 */
export const GROUNDING_POLICY_TARGETS = Object.freeze(['transcript', 'summary', 'findings'] as const);

/**
 * The grounding POLICY SET — the owner's specification, expressed as configuration.
 *
 * > "Grounding is a set of policies defined/declared/overwriten by tenant admin where LLM will
 * > follow and evaluate the: redacted transcript (errors fixes including grammar, spellings,
 * > etc), redacted summary (especially grammar, spelling, medical terms, concepts, detected named
 * > entities, etc.), highlighted important information/findings."
 *
 * Four words in that sentence decide the shape. **"set"** — an ARRAY, so a tenant declares as
 * many policies as it has, and each one can be turned off without deleting it. **"defined /
 * declared / overwriten by tenant admin"** — each policy's instruction is a `promptTemplateId`,
 * a governed template the tenant authors and approves, never a string typed into this file.
 * **"LLM will follow"** — there is no score formula and no rubric here; the model follows the
 * tenant's own words. **"evaluate the: ... , ... , ..."** — `appliesTo` says WHICH of the three
 * the policy governs, drawn from {@link GROUNDING_POLICY_TARGETS}.
 *
 * `key` is the tenant's own stable handle for the policy, so a verdict can name the policy that
 * produced it and an admin can recognise it. It is opaque to the platform on purpose: a
 * platform-owned key set would be a platform-owned policy catalogue, which is the thing this
 * whole property exists NOT to be.
 *
 * ABSENT `policies` is a real and supported state, not an unfinished one: the guard then behaves
 * exactly as it did before this ticket. That is what makes the addition safe for every graph
 * already published with a `guard.groundedness` node in it.
 */
const GROUNDING_POLICIES_PROPERTY = Object.freeze({
  type: 'array',
  description: 'The tenant-authored grounding policies this guard evaluates. Absent or empty means the guard runs its pre-existing pass unchanged.',
  items: Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: ['key', 'appliesTo', 'promptTemplateId'],
    properties: {
      key: { type: 'string', minLength: 1, description: 'The tenant`s own stable handle for this policy. Opaque to the platform.' },
      appliesTo: {
        type: 'string',
        enum: GROUNDING_POLICY_TARGETS,
        description: 'Which of the guard`s three evaluation inputs this policy governs.',
      },
      promptTemplateId: PROMPT_TEMPLATE_ID_PROPERTY,
      promptVersionNumber: PROMPT_VERSION_NUMBER_PROPERTY,
      enabled: {
        type: 'boolean',
        description:
          'Turn one policy off without deleting it. Absent is ENABLED — a declared policy that silently did nothing would be worse than no policy.',
      },
    },
  }),
});

/**
 * `guard.groundedness` — the groundedness gate as a first-class, ATTACHABLE node.
 *
 * `realtime-lane.ts` records the gap this closes in its own words: *"There is no groundedness NODE
 * because the registry has no groundedness node type; the gate is a GUARD attached to the
 * generation node"*. `threshold` is the one knob that is already load-bearing rather than
 * invented — `guard-memo.ts` keys its memo on `(guard, config, input)` precisely because *"a
 * discharge summary held to 0.9 and a running note to 0.6 are two genuinely different verdicts on
 * the same text"*.
 */
const GUARD_GROUNDEDNESS_SCHEMA: NodeConfigSchema = Object.freeze({
  title: 'guard.groundedness node config (DD-7, extended by with tenant-authored policies)',
  type: 'object',
  additionalProperties: false,
  required: ['onError'],
  properties: {
    threshold: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'The groundedness score below which the guarded document is marked ungrounded. Per-node, by design (guard-memo.ts).',
    },
    // the routing key `nodes/guards.py:203` ALREADY reads
    // (`payload.config.get("taskKey") or "text.finalize"`), declared so an admin can
    // actually author it. Every schema here is `additionalProperties: false`, so until now
    // the activity honoured a key the Studio stripped — the same two-halves-disagree defect
    // the ADDENDUM at the foot of this module closed for `timeoutSeconds`/`retry`. The enum
    // is `_llm_policy.ALLOWED_TASK_KEYS` and the default is that activity's own literal, so
    // an unauthored node keeps resolving byte-identically.
    taskKey: { type: 'string', enum: ['text.finalize', 'text.live', 'text.test'], default: 'text.finalize' },
    policies: GROUNDING_POLICIES_PROPERTY,
    onError: CONSULTATION_ON_ERROR,
  },
});

// ===========================================================================================
// the GENERIC (`agentic`) node catalogue
// ===========================================================================================
//
// Program finding F-12: *"Missing: Loop, Data, TTS, and any generic Agent"* — Agent existed only
// as ~13 FIXED-PURPOSE types (`agent.summarization`, `agent.ner`, …), each of which encodes its
// behaviour in its KEY. The eight types below encode behaviour in CONFIGURATION instead, which is
// the whole point: a tenant composes an agent rather than picking one off a shelf. The fixed
// types stay registered and untouched (a node type is a contract with every saved graph); new
// work targets these.
//
// ## The rule that shapes every schema here: REFERENCES ONLY ( rule 16)
//
// A node config is TENANT GRAPH DATA. A model id, an endpoint, an API key or a deployment name
// stored in it would be read at run time WITHOUT passing through the tenant → SYSTEM cascade, and
// — worse, because it is silent — without passing through BYOK funding derivation, which decides
// `BYOK` vs `CLOUD` from `row.tenantId === SYSTEM_TENANT_ID`. A graph carrying its own endpoint
// mis-bills every run it serves and nothing fails.
//
// So every binding below names a ROW and stops:
//
//   providerConfigRef.routingPolicyId -> AiRoutingPolicy.id (connection + model + modelRef)
//   providerConfigRef.taskKey -> the tenant's ELECTED default for that task
//   tools[].mcpServerId -> McpServer.id (baseUrl + authRef live there)
//   guards.input/output[] -> a node id IN THIS GRAPH
//   instruction.promptTemplateId -> PromptTemplate.id, version-pinned
//
// There is deliberately no `provider`, no `model`, no `endpoint`, no `apiKey`, no `baseUrl` and
// no `headers` key anywhere in this catalogue, and `additionalProperties: false` means one cannot
// be smuggled in. `__tests__/reference-only.task847.test.ts` proves that mechanically over the
// whole registry rather than trusting this comment.

/** A UUID reference to a row in another table. Never the row's contents. */
const ROW_REFERENCE_PROPERTY = Object.freeze({
  type: 'string',
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});

/**
 * The generation hyper-parameters, INCLUDING the two program finding F-12 recorded as absent.
 *
 * `frequencyPenalty` and `presencePenalty` are not universally supported — llama.cpp and vLLM
 * accept them, several managed endpoints do not, and a provider that does not accept one
 * typically IGNORES it rather than erroring. Silently dropping a parameter a clinician tuned is
 * worse than refusing it, so these are CAPABILITY-GATED: `hyperparameterCapabilityProblems`
 * (`agentic-contract.ts`) refuses a graph that sets a parameter the bound provider configuration
 * does not declare support for. The gate lives there and not here because the capability set is
 * DATA (it comes off the resolved provider row) and this package is pure.
 *
 * Ranges follow the OpenAI-compatible convention every adapter in this platform speaks; they are
 * a floor on nonsense, not a claim that every provider accepts the whole range. The real CEILING
 * is a platform-admin descriptor enforced in `apps/text` (ticket step 5) — vLLM's
 * `--override-generation-config` sets DEFAULTS and the caller wins, so an engine-side ceiling is
 * not a ceiling at all.
 */
const GENERATION_HYPERPARAMETERS_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    temperature: Object.freeze({ type: 'number', minimum: 0, maximum: 2 }),
    maxTokens: Object.freeze({ type: 'integer', minimum: 1, maximum: 1048576 }),
    topP: Object.freeze({ type: 'number', minimum: 0, maximum: 1 }),
    frequencyPenalty: Object.freeze({
      type: 'number',
      minimum: -2,
      maximum: 2,
      summary: 'Only works if the connected provider supports it.',
      description: 'Capability-gated: refused at publish when the bound provider configuration does not declare support for it.',
    }),
    presencePenalty: Object.freeze({
      type: 'number',
      minimum: -2,
      maximum: 2,
      summary: 'Only works if the connected provider supports it.',
      description: 'Capability-gated: refused at publish when the bound provider configuration does not declare support for it.',
    }),
    stopSequences: Object.freeze({ type: 'array', maxItems: 8, items: Object.freeze({ type: 'string', minLength: 1, maxLength: 128 }) }),
    seed: Object.freeze({ type: 'integer', minimum: 0, maximum: 2147483647 }),
  }),
  summary: 'Fine-tuning knobs for how the agent generates text.',
  description: 'Generation hyper-parameters. Every key is capability-gated against the bound provider configuration — never silently dropped.',
});

/** A tenant-authored JSON Schema, carried verbatim. Validated by `authorableJsonSchemaProblems`
 *  at publish (the same subset a `ConsultationContextSchema` is bound by) and enforced again at
 *  the node boundary at run time — TIER 3, where correctness actually lives. */
const TENANT_IO_SCHEMA_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  summary: 'The shape of the data — its fields and types.',
  description: 'A tenant-defined JSON Schema (authorable subset) describing the payload crossing this boundary.',
});

/**
 * The DATA node — a deterministic reshape between two schemas, and the tier-2 ESCAPE HATCH.
 *
 * Tier 2 (`schema-compat.ts`) WARNS when a producer's declared output shape does not obviously
 * satisfy a consumer's declared input shape. The warning is only useful if there is something to
 * do about it, and this is that something: drop a Data node on the edge and map the fields. That
 * is why the mapping language is deliberately tiny — dotted reads, renamed writes, literal
 * constants. Anything richer is a transformation language, which is a second place for tenant
 * logic to live and a second thing to audit.
 */
const AGENTIC_DATA_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/agentic.data.schema.json',
  title: 'agentic.data node config — deterministic reshape, the tier-2 escape hatch',
  summary: 'Reshapes data from one step into what the next step expects.',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['mappings']),
  properties: Object.freeze({
    mappings: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['from', 'to']),
        properties: Object.freeze({
          from: Object.freeze({
            type: 'string',
            minLength: 1,
            maxLength: 256,
            summary: 'Where this value comes from.',
            description: 'Dotted path into this node`s bound inputs.',
          }),
          to: Object.freeze({
            type: 'string',
            pattern: '^[a-z0-9_]{2,48}$',
            summary: 'The name this value gets on the way out.',
            description: 'Key on this node`s output object.',
          }),
          required: Object.freeze({
            type: 'boolean',
            default: false,
            summary: 'Fail the node if this value cannot be found.',
            description: 'An unresolved REQUIRED mapping degrades the node observably; an optional one is simply absent.',
          }),
        }),
      }),
    }),
    constants: Object.freeze({
      type: 'object',
      summary: 'Fixed values added to the output every time.',
      description: 'Literal values merged into the output. Non-secret by construction: this is graph data.',
    }),
    outputSchema: TENANT_IO_SCHEMA_PROPERTY,
  }),
});

/**
 * The LOOP node's bounds — THREE axes, and the third is the one the owner's specification did
 * not name.
 *
 * `maxIterations` and `maxDurationSeconds` bound the schedule. Neither bounds the INVOICE: fifty
 * iterations of a large model is an unbounded bill that completes successfully, on time, and
 * looks like a healthy run. `maxTotalTokens` is the cost ceiling, and it is REQUIRED for exactly
 * that reason — an optional ceiling is one nobody sets.
 *
 * `maxDurationSeconds` is spent as a TEMPORAL WORKFLOW TIMER (`workflow.sleep` /
 * `asyncio.wait_for` on the workflow clock), never as wall-clock. Reading a wall clock inside
 * `@workflow.defn` is non-deterministic and breaks replay — the run would take a different number
 * of iterations the second time history is fed through it, which for a clinical pipeline means a
 * completed run that cannot be reproduced. owns the enforcement; this declares what it
 * must enforce.
 *
 * `noProgressIterations` is the fourth stop condition and the one that catches the common failure
 * an iteration cap does not: an orchestrator that has converged and is now paraphrasing itself
 * burns the whole budget to reach the same answer.
 */
const AGENTIC_LOOP_BOUNDS_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['maxIterations', 'maxDurationSeconds', 'maxTotalTokens']),
  properties: Object.freeze({
    maxIterations: Object.freeze({ type: 'integer', minimum: 1, maximum: 100 }),
    maxDurationSeconds: Object.freeze({
      type: 'integer',
      minimum: 1,
      maximum: 3600,
      summary: 'The longest this loop is allowed to run.',
      description: 'Spent as a Temporal WORKFLOW TIMER, never wall-clock — a wall-clock read inside a workflow breaks replay determinism.',
    }),
    maxTotalTokens: Object.freeze({
      type: 'integer',
      minimum: 1,
      maximum: 4000000,
      summary: 'The most this loop is allowed to spend, in tokens.',
      description:
        'The COST ceiling, summed across every iteration and every sub-agent. Required: an iteration cap bounds the schedule, not the invoice.',
    }),
    noProgressIterations: Object.freeze({
      type: 'integer',
      minimum: 1,
      maximum: 20,
      default: 2,
      summary: 'Stops early if repeats keep producing the same result.',
      description: 'Stop after this many consecutive iterations that produce no change in the orchestrator`s working state.',
    }),
  }),
});

// ===========================================================================================
// TASK-864 — the `core` vocabulary's config schemas.
//
// One palette, nine primitives, behaviour as CONFIGURATION. The same reference-only discipline
// the `agentic` catalogue set applies here without exception: an Agent node names a published
// Agent by SLUG, a Classify node names a registry model by SLUG, a Trigger names a context-schema
// row by id. Nothing here is a provider, a model id, an endpoint or a credential
// (`reference-only.task847.test.ts` sweeps these too).
// ===========================================================================================

/** A tenant-authored slug (`WORKFLOW_DEFINITION_SLUG_PATTERN`, mirrored for the schema). */
const SLUG_PATTERN = '^[a-z0-9][a-z0-9_-]{0,78}[a-z0-9]$';

/** An authoring KEY — the same grammar as a node id (`WORKFLOW_NODE_ID_PATTERN`). */
const KEY_PATTERN = '^[a-z0-9_]{2,48}$';

/** A CEL expression (TASK-864 §3.2). Parse-checked at publish by `expressionProblems`. */
const CEL_EXPRESSION_PROPERTY = Object.freeze({
  type: 'string',
  // A JSON-Schema annotation (never asserted): the Studio's inspector renders `format: 'cel'`
  // strings through its expression editor instead of a plain text box (TASK-864 B1).
  format: 'cel',
  minLength: 1,
  maxLength: 2000,
  summary: 'True or false — decides whether this path runs.',
  description:
    'A CEL expression over the run context — `trigger.*`, `vars.*`, `nodes.<id>.*`. Deterministic and side-effect free; type-checked at publish and evaluated by the interpreter.',
});

/**
 * TASK-890 §3.14 (OD-R clause 3) — the guardrail OVERRIDE, on the two nodes that can carry an
 * opinion about a whole call: a `core.agent` node (this instance) and `core.trigger` (this
 * workflow's default).
 *
 * TRI-STATE BY ABSENCE, the `mcpToolsEnabled` shape: the object absent — or present with no
 * `enabled` — means INHERIT, which is why there is no `default: true` here and why
 * `additionalProperties: false` matters. `resolveGuardrailDecision` (`guardrail-optout.ts`)
 * folds node > workflow > agent > `true` and names WHICH level decided, so the answer is
 * attributable rather than merely computed. A pushed `true` never turns a platform kill-switch
 * back on: `apps/text` keeps `platform.enabled` as the floor.
 */
/**
 * TASK-932 R-16a — the DNA writing-style declaration on a `core.agent` instance.
 *
 * TASK-891 OD-5: the workflow NAMES the DNA-redaction agent. In the `core` vocabulary that agent
 * is the finalizing `core.agent` (cadence `onEnd`) whose instruction renders
 * `{{context.dna_style_text}}`; `dna.enabled: true` is how the graph DECLARES it, and it is what
 * the gateway's DNA gate (`ConfigResolver.resolveEffectiveDnaStyleEnabled`) reads — the legacy
 * `agent.dna_style` node type is not part of this vocabulary, so without this flag the
 * clinician's style could never reach the note.
 */
const DNA_PROPERTY = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    enabled: Object.freeze({
      type: 'boolean',
      summary: 'Apply the clinician\'s DNA writing style when this agent generates.',
      description:
        'TRUE declares this node as the DNA writing-style pass (TASK-891 OD-5). The clinician\'s own opt-out still vetoes it; ABSENT means the graph declares no DNA pass.',
    }),
  }),
});

const GUARDRAIL_OVERRIDE_PROPERTY = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    enabled: Object.freeze({
      type: 'boolean',
      summary: 'On, off, or inherit the default safety setting.',
      description:
        'Whether platform guardrail screens this call. ABSENT = inherit (workflow, then agent, then on). A publish WARNING (`GUARDRAIL_OPTED_OUT`) and a per-call usage attribute record every `false`.',
    }),
  }),
  summary: 'Turn safety screening on or off for this workflow.',
  description: 'Guardrail opt-out for this scope. Absent means inherit — never "unset".',
});

const CORE_TRIGGER_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.trigger.schema.json',
  title: 'core.trigger node config — the graph`s ONE entry point',
  summary: 'Starts the workflow and defines what data comes in.',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['kinds']),
  properties: Object.freeze({
    kinds: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: Object.freeze({ type: 'string', enum: Object.freeze(['consultation', 'api', 'webhook', 'schedule']) }),
      summary: 'Which ways this workflow can be started.',
      description:
        'Which trigger kinds may start this workflow. `consultation` = the clinical plane (session open); `api` = POST /workflows/{slug}/runs; `webhook` = POST /hooks/workflows/{slug}; `schedule` is reserved.',
    }),
    contextSchema: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        inline: TENANT_IO_SCHEMA_PROPERTY,
        contextSchemaId: Object.freeze({
          ...ROW_REFERENCE_PROPERTY,
          summary: 'A saved context shape to reuse instead of writing one.',
          description: 'A `ConsultationContextSchema` row — a REFERENCE; the schema body lives on the row.',
        }),
        versionNumber: Object.freeze({ type: 'integer', minimum: 1 }),
      }),
      summary: 'The shape of data available to the whole session.',
      description:
        'The consultation-context object schema available to the whole session, authored inline or referenced by row. The run payload is validated against it before any node runs.',
    }),
    guardrail: GUARDRAIL_OVERRIDE_PROPERTY,
    sampleInput: Object.freeze({
      type: 'object',
      summary: 'An example input, shown in the Studio and docs only.',
      description: 'An example payload for the Studio and the generated docs. Never executed.',
    }),
  }),
});

/**
 * `core.agent` — ONE task, by REFERENCE to a published Agent (TASK-863). Ports are the union of
 * every task's sockets (`node-ports.ts`); `overrides` are bounded by the agent's own declared
 * ranges at publish (`coreNodeConfigProblems`, once the agent row is resolvable), and
 * `execution` is what used to be the registry's per-TYPE `lane`/`trigger`: it is now per
 * INSTANCE, so one summarizer can run live and at finalization without two node types.
 */
const CORE_AGENT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.agent.schema.json',
  title: 'core.agent node config — one task, one published Agent, by reference',
  summary: 'Runs one published agent to do a task.',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['agentRef']),
  properties: Object.freeze({
    agentRef: Object.freeze({
      type: 'object',
      additionalProperties: false,
      required: Object.freeze(['slug']),
      properties: Object.freeze({
        slug: Object.freeze({
          type: 'string',
          pattern: SLUG_PATTERN,
          summary: 'Which published agent runs this step.',
          description: 'The published Agent`s slug, resolved [tenant, SYSTEM] preferring tenant. A REFERENCE — never a model, provider or endpoint.',
        }),
        versionNumber: Object.freeze({
          type: 'integer',
          minimum: 1,
          summary: 'Pin one version of the agent instead of using the latest.',
          description: 'Pin one published version. Absent means the agent`s ACTIVE version.',
        }),
      }),
    }),
    overrides: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        promptVariables: Object.freeze({
          type: 'object',
          additionalProperties: Object.freeze({ type: 'string', maxLength: 4000 }),
          summary: 'Fill in the agent prompt with values from this workflow.',
          description:
            'Values for the agent`s instruction-template variables. `{{vars.key}}` / `{{nodes.id.key}}` / `{{trigger.key}}` interpolate from the run context.',
        }),
        generation: GENERATION_HYPERPARAMETERS_PROPERTY,
        carryForward: CARRY_FORWARD_PROPERTY,
      }),
      summary: 'Adjustments to the agent defaults for this node only.',
      description:
        'Per-node overrides, limited to prompt variables, hyper-parameters within the agent`s declared ranges, and the re-visit carry-forward switch.',
    }),
    execution: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        lane: Object.freeze({
          type: 'string',
          enum: Object.freeze(['durable', 'realtime']),
          default: 'durable',
          summary: 'Whether this step runs live or in the background.',
          description:
            'WHICH RUNTIME executes this instance. `realtime` = the gateway`s live executor (the durable interpreter skips it, reason `realtime_lane`).',
        }),
        cadence: Object.freeze({
          type: 'string',
          enum: Object.freeze(['once', 'perTurn', 'onStart', 'onEnd']),
          default: 'once',
          summary: 'When this step runs during the session.',
          description:
            'WHEN it runs — `once` at the run`s start, `onStart` once when the LIVE session opens (before any turn), ' +
            '`perTurn` on every live turn, `onEnd` once at the close. `onStart` is a REALTIME cadence: it is the ' +
            'warm-start slot (pre-summary of the prior record) the live executor runs in parallel with the capture ' +
            'session, and the durable interpreter skips it with every other `execution.lane: realtime` node.',
        }),
      }),
    }),
    ...DOCUMENT_BINDING_PROPERTIES,
    guardrail: GUARDRAIL_OVERRIDE_PROPERTY,
    dna: DNA_PROPERTY,
    onError: Object.freeze({ type: 'string', enum: Object.freeze(['fail', 'degrade']) }),
  }),
});

/**
 * TASK-932 D-9 — the execution cadences a `core.agent` / `core.action` instance may declare,
 * exported so a runtime reads the vocabulary instead of re-typing its string literals.
 *
 * `onStart` is the REALTIME warm-start slot: it runs ONCE when the live session opens, before
 * the first turn, in parallel with the capture session. It is what makes the pre-summary of the
 * prior record a node of the graph rather than a call the console happens to make; the durable
 * interpreter skips it exactly as it skips every other `execution.lane: 'realtime'` node with a
 * live owner (`_configured_realtime` in `apps/harness/.../interpreter/workflow.py`), so no
 * harness registry change is implied by adding it — the vocabulary the interpreter mirrors is
 * `NODE_REGISTRY` / `ACTION_CATALOGUE`, and neither reads a cadence.
 */
export const NODE_EXECUTION_CADENCES = Object.freeze(['once', 'perTurn', 'onStart', 'onEnd'] as const);

/** One of {@link NODE_EXECUTION_CADENCES}. */
export type NodeExecutionCadence = (typeof NODE_EXECUTION_CADENCES)[number];

const CORE_CLASSIFY_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.classify.schema.json',
  title: 'core.classify node config — route text into one of the declared classes',
  summary: 'Sorts text into one of your defined categories.',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['modelSlug', 'classes']),
  properties: Object.freeze({
    modelSlug: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 128,
      summary: 'Which classification model sorts the text.',
      description:
        'An `AiModel.slug` whose task is TEXT_CLASSIFICATION or TOKEN_CLASSIFICATION (TASK-860 registry). A REFERENCE — never an engine or a model id.',
    }),
    classes: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['key', 'label']),
        properties: Object.freeze({
          key: Object.freeze({
            type: 'string',
            pattern: KEY_PATTERN,
            summary: 'The output name for this category.',
            description: 'The branch handle name. One output handle per class.',
          }),
          label: Object.freeze({ type: 'string', minLength: 1, maxLength: 200 }),
          description: Object.freeze({ type: 'string', maxLength: 2000 }),
          labels: Object.freeze({
            type: 'array',
            maxItems: 32,
            items: Object.freeze({ type: 'string', minLength: 1, maxLength: 128 }),
            summary: 'Which of the model labels belong to this category.',
            description:
              'Which of the model`s own labels map onto this class. For a TEXT_CLASSIFICATION model, absent means the class key IS the label. For a TOKEN_CLASSIFICATION model the labels are ENTITY TYPES, and the first class naming none of them is the catch-all: it is taken when any span clears `threshold`, while "nothing found" takes `otherwise`.',
          }),
        }),
      }),
    }),
    mode: Object.freeze({ type: 'string', enum: Object.freeze(['single', 'multi']), default: 'single' }),
    threshold: Object.freeze({
      type: 'number',
      minimum: 0,
      maximum: 1,
      summary: 'Below this confidence, no category is chosen.',
      description: 'Below it, no class is taken and `otherwise` fires.',
    }),
    spans: Object.freeze({
      type: 'boolean',
      default: false,
      summary: 'Also return exactly where a match was found in the text.',
      description: 'Token-classification models: also emit the matched spans.',
    }),
    onError: Object.freeze({ type: 'string', enum: Object.freeze(['fail', 'degrade']) }),
  }),
});

const CORE_HUMAN_REVIEW_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.humanReview.schema.json',
  title: 'core.humanReview node config — a durable hold-out for a human decision',
  summary: 'Pauses the run for a person to approve or reject.',
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    reviewType: Object.freeze({ type: 'string', minLength: 1, maxLength: 64, default: 'approval' }),
    instructions: Object.freeze({
      type: 'string',
      maxLength: 4000,
      summary: 'What the reviewer sees when deciding.',
      description: 'Shown to the reviewer. Never a prompt.',
    }),
    assignRole: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 64,
      summary: 'Which role can make this decision.',
      description: 'The role whose members may decide (TASK-859 OD-9: role only, today).',
    }),
    timeoutSeconds: Object.freeze({
      type: 'integer',
      minimum: 1,
      maximum: 604800,
      summary: 'How long to wait before the review times out.',
      description: 'How long the run waits before `timedOut` fires. A timeout NEVER approves.',
    }),
    escalation: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        afterSeconds: Object.freeze({ type: 'integer', minimum: 1, maximum: 604800 }),
        maxEscalations: Object.freeze({ type: 'integer', minimum: 0, maximum: 10 }),
      }),
    }),
    allowEdit: Object.freeze({
      type: 'boolean',
      default: false,
      summary: 'Let the reviewer submit changes along with their decision.',
      description: 'Whether the reviewer may return an edited payload with the decision.',
    }),
  }),
});

const CORE_VARIABLE_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.variable.schema.json',
  title: 'core.variable node config — declare run variables with defaults',
  summary: 'Defines reusable values other nodes can use.',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['variables']),
  properties: Object.freeze({
    variables: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['key']),
        properties: Object.freeze({
          key: Object.freeze({
            type: 'string',
            pattern: KEY_PATTERN,
            summary: 'The name other nodes use to read this value.',
            description: 'Readable as `vars.<key>` everywhere.',
          }),
          schema: TENANT_IO_SCHEMA_PROPERTY,
          // `default` may be any JSON value; the authorable subset expresses that as an
          // unconstrained schema (`{}` accepts anything, per JSON Schema).
          default: Object.freeze({ summary: 'The starting value before anything changes it.', description: 'The initial value. Any JSON value.' }),
        }),
      }),
    }),
  }),
});

const CORE_CONDITION_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.condition.schema.json',
  title: 'core.condition node config — If/Else routing over CEL expressions',
  summary: 'Sends the run down different paths based on a rule.',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['branches']),
  properties: Object.freeze({
    branches: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['key', 'when']),
        properties: Object.freeze({
          key: Object.freeze({
            type: 'string',
            pattern: KEY_PATTERN,
            summary: 'The name of this path, shown on the canvas.',
            description: 'The branch handle name.',
          }),
          label: Object.freeze({ type: 'string', maxLength: 200 }),
          when: CEL_EXPRESSION_PROPERTY,
        }),
      }),
      summary: 'The first matching path is taken.',
      description: 'Evaluated in order; the FIRST true branch is taken, else the `else` handle.',
    }),
  }),
});

const CORE_LOOP_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.loop.schema.json',
  title: 'core.loop node config — repeat a sub-graph, bounded on every axis',
  summary: 'Repeats a set of steps until a condition is met.',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['mode', 'bounds']),
  properties: Object.freeze({
    mode: Object.freeze({ type: 'string', enum: Object.freeze(['foreach', 'while']) }),
    over: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 256,
      summary: 'The list this loop goes through, one item at a time.',
      description: '`foreach`: a dotted path into the run context naming the array to iterate (`nodes.split.items`, `trigger.documents`).',
    }),
    until: Object.freeze({
      ...CEL_EXPRESSION_PROPERTY,
      summary: 'Stops the loop when this becomes true.',
      description: '`while`: the loop ends when this CEL expression is true. Re-evaluated after every iteration.',
    }),
    bounds: AGENTIC_LOOP_BOUNDS_PROPERTY,
    collect: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 256,
      summary: 'Which part of each round result to keep.',
      description: 'A dotted path into each iteration`s result whose values are collected onto `done`. Absent collects the whole result.',
    }),
  }),
});

const CORE_NOTE_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.note.schema.json',
  title: 'core.note node config — a canvas comment, never compiled',
  summary: 'A comment on the canvas. Has no effect on the run.',
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    text: Object.freeze({ type: 'string', maxLength: 4000 }),
    color: Object.freeze({ type: 'string', enum: Object.freeze(['neutral', 'info', 'warning', 'success']), default: 'neutral' }),
  }),
});

const CORE_OUTPUT_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.output.schema.json',
  title: 'core.output node config — the graph`s end point and its published protocols',
  summary: 'Ends the workflow and delivers the result.',
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({
    outputSchema: TENANT_IO_SCHEMA_PROPERTY,
    protocols: Object.freeze({
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: Object.freeze({ type: 'string', enum: Object.freeze(['http', 'http-sse', 'socket']) }),
      default: Object.freeze(['http-sse']),
      summary: 'How callers can reach this workflow once published.',
      description:
        'Under which protocols the published workflow is reachable. Bounds `?mode=` at invocation: `http` -> blocking, `http-sse` -> stream, `socket` -> the WS stream; `async` is always allowed.',
    }),
    onSchemaViolation: Object.freeze({ type: 'string', enum: Object.freeze(['fail', 'degrade']), default: 'fail' }),
    claimCheck: Object.freeze({ type: 'string', enum: Object.freeze(['auto', 'always', 'never']), default: 'auto' }),
    notify: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        webhook: Object.freeze({
          type: 'boolean',
          default: true,
          summary: 'Send a completion notification with no patient data in it.',
          description: 'Emit the run-completed webhook (PHI-free payload).',
        }),
      }),
    }),
  }),
});

/**
 * `core.action` — every remaining fixed-purpose clinical step as ONE node type keyed by
 * `actionKey`. The action's own config travels under `action` and is validated at publish
 * against the delegated legacy node type's schema (`core-contract.ts`), so the per-type
 * schemas move under the key unchanged rather than being re-authored.
 */
const CORE_ACTION_SCHEMA: NodeConfigSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://arcaai.dev/hope/workflow-nodes/core.action.schema.json',
  title: 'core.action node config — a platform action, by key',
  summary: 'Runs a built-in platform action you choose from a list.',
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['actionKey']),
  properties: Object.freeze({
    actionKey: Object.freeze({
      type: 'string',
      minLength: 1,
      maxLength: 64,
      summary: 'Which built-in action this node performs.',
      description:
        'A key of the action catalogue (`ACTION_CATALOGUE`). Selects the activity, the effective ports and the config schema under `action`.',
    }),
    action: Object.freeze({
      type: 'object',
      summary: 'Settings for the chosen action.',
      description: 'The action`s own config — the delegated node type`s schema, unchanged.',
    }),
    execution: Object.freeze({
      type: 'object',
      additionalProperties: false,
      properties: Object.freeze({
        lane: Object.freeze({ type: 'string', enum: Object.freeze(['durable', 'realtime']) }),
        cadence: Object.freeze({ type: 'string', enum: Object.freeze(['once', 'perTurn', 'onStart', 'onEnd']) }),
      }),
    }),
    onError: Object.freeze({ type: 'string', enum: Object.freeze(['fail', 'degrade']) }),
  }),
});

/**
 * Node-type key -> AUTHORED config JSON Schema. A key ABSENT from this map means no schema has
 * been authored for that node type yet (`WORKFLOW_NODE_REGISTRY[key].configSchema` stays
 * `undefined`) — a real, structural, always-possible state (see this module's docstring),
 * not an omission to fix here.
 *
 * This is the AUTHORED half. The exported `NODE_CONFIG_SCHEMAS` below folds the palette-agnostic
 * runtime knobs into every entry — see the ADDENDUM at the foot of this module.
 */
const AUTHORED_NODE_CONFIG_SCHEMAS: Readonly<Record<string, NodeConfigSchema>> = Object.freeze({
  'core.trigger': CORE_TRIGGER_SCHEMA,
  'core.agent': CORE_AGENT_SCHEMA,
  'core.classify': CORE_CLASSIFY_SCHEMA,
  'core.humanReview': CORE_HUMAN_REVIEW_SCHEMA,
  'core.variable': CORE_VARIABLE_SCHEMA,
  'core.condition': CORE_CONDITION_SCHEMA,
  'core.loop': CORE_LOOP_SCHEMA,
  'core.note': CORE_NOTE_SCHEMA,
  'core.output': CORE_OUTPUT_SCHEMA,
  'core.data': AGENTIC_DATA_SCHEMA,
  'core.action': CORE_ACTION_SCHEMA,
});

/** TASK-893 — the authored schemas of the 17 ACTIONS behind `core.action`, keyed by action key (see `ACTION_CONFIG_SCHEMAS`). */
const AUTHORED_ACTION_CONFIG_SCHEMAS: Readonly<Record<string, NodeConfigSchema>> = Object.freeze({
  'prompt.template_ref': PROMPT_TEMPLATE_REF_SCHEMA,
  'consultation.consentGate': CONSULTATION_CONSENT_GATE_SCHEMA,
  'consultation.bindTerminology': CONSULTATION_BIND_TERMINOLOGY_SCHEMA,
  'consultation.phiHop': CONSULTATION_PHI_HOP_SCHEMA,
  'consultation.retrieveEvidence': CONSULTATION_RETRIEVE_EVIDENCE_SCHEMA,
  'consultation.sensors': CONSULTATION_SENSORS_SCHEMA,
  'consultation.inferentialSensors': CONSULTATION_SENSORS_SCHEMA,
  'consultation.persistDraft': CONSULTATION_PERSIST_DRAFT_SCHEMA,
  'consultation.finalizeAssurance': CONSULTATION_FINALIZE_ASSURANCE_SCHEMA,
  'session.timeout': SESSION_TIMEOUT_SCHEMA,
  'summary.finalize': SUMMARY_FINALIZE_SCHEMA,
  'feedback.capture': FEEDBACK_CAPTURE_SCHEMA,
  'livedoc.stop': LIVEDOC_STOP_SCHEMA,
  'harness.finalize': HARNESS_FINALIZE_SCHEMA,
  'guard.phi': CONSULTATION_PHI_HOP_SCHEMA,
  'guard.moderation': GUARDRAIL_CHECK_SCHEMA,
  'guard.groundedness': GUARD_GROUNDEDNESS_SCHEMA,
});

// ===========================================================================================
// ADDENDUM — the palette-agnostic RUNTIME knobs `compileNode` reads off EVERY node
// (lane A, item 5; the addendum promised at line ~505 and never wrote)
// ===========================================================================================
//
// `compiler.ts`'s `compileNode` reads three keys off `node.config` for every node it compiles:
// `timeoutSeconds`, `retry` and `onError`. Until now NO schema declared the first two, and every
// schema sets `additionalProperties: false` — so the two halves of the platform disagreed about
// the same object: the engine honoured a per-node budget and retry ceiling that an admin could
// not author, and a graph that DID carry them failed publish on an undeclared property.
//
// The decision (recorded because the alternative was live): **declare them once, here**, rather
// than deleting the compiler's reads. Deleting them would remove a capability that is genuinely
// exercised — `compileGate` reads `timeoutSeconds` on the one durable human wait, and
// realtime executor takes its PER-NODE budget and retry ceiling straight off the compiled
// `timeoutSeconds` / `retry.maximumAttempts` (`realtime-lane.ts`'s `RealtimeNode`). A per-node
// budget is the mechanism by which one slow model does not stall another; it is not dead code.
//
// Folded in HERE rather than pasted into ~36 literals for the same reason `NODE_PORTS` is
// attached in `node-registry.ts` rather than inlined: a uniform property that must appear on
// every node is a derivation, and a derivation cannot be forgotten on the next node someone adds.
// An authored schema that already declares one of these keys KEEPS its own declaration
// (`consultation.hitlGate` declares a gate-scoped `timeoutSeconds`), so this can only ever add.
//
// `onError` is deliberately NOT folded in: the consultation palette declares it with WF-CONS-019's
// own enum, and the summarization/STT schemas that omit it would need a vocabulary this module
// cannot derive (`compileNode` treats every value that is not `'degrade'` as `'fail'`, so the
// consultation enum's `'retry'` is already an authoring-time value with no compiled meaning).
// That is a real, separate gap — reported, not silently papered over with a guessed enum.
//
// adds a THIRD key to this fold, `enabled`, on the same argument one level over: it is
// read by the two RUNTIMES rather than by `compileNode` (which passes `config` through
// wholesale), it was already honoured by one of them, and it was undeclared — so it was stripped
// by the validator and undrawn by the inspector, exactly as `timeoutSeconds`/`retry` were. It is
// the first folded key with an EXCLUSION SET of its own; see `GRAPH_BOUNDARY_NODE_TYPES` below
// (TASK-890 D-1 narrowed that set from `MANDATORY_NODE_TYPES` to the two graph boundaries).

/** The per-node retry ceiling `compileNode` clamps against `caps.maxAttempts`. Mirrors
 *  `CompiledRetryPolicy` exactly; a key the compiler does not read is not offered. */
const NODE_RETRY_SCHEMA: NodeConfigSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    maximumAttempts: {
      type: 'integer',
      minimum: 1,
      summary: 'The most times this node retries before giving up.',
      description: 'Clamped to the definition`s `caps.maxAttempts` at compile time.',
    },
    initialIntervalSeconds: {
      type: 'number',
      minimum: 0,
      summary: 'How long to wait before the first retry.',
      description: 'First retry delay, in seconds.',
    },
    backoffCoefficient: {
      type: 'number',
      minimum: 1,
      summary: 'How much longer to wait between each retry.',
      description: 'Multiplier applied to the interval after each attempt.',
    },
  },
});

/**
 * item 3 — the per-node KILL SWITCH, declared at last.
 *
 * Both runtimes read this key off `CompiledNode.config`: realtime executor as
 * `enabled: node.config?.enabled !== false` (`realtime-lane.ts`), and the durable interpreter's
 * `_dispatch_node` as a `SKIPPED(disabled_by_config)` branch. Neither compiles
 * it — `compileNode` passes `config` through wholesale — so unlike `timeoutSeconds`/`retry` this
 * is a key the RUNTIMES read rather than the compiler, and it is folded in here for exactly the
 * reason they are: an undeclared key is stripped twice over (the validator rejects it under
 * `additionalProperties: false`, and the Studio inspector draws no field for it), so the toggle
 * the runtimes already honoured was unreachable from the supported authoring path.
 *
 * `default: true` is not decoration. ABSENT MUST MEAN ON: every graph published before this
 * ticket carries no `enabled` key, and both runtimes therefore test for the literal `false`
 * rather than for falsiness.
 */
const NODE_ENABLED_PROPERTY: NodeConfigSchema = Object.freeze({
  type: 'boolean',
  default: true,
  summary: 'Skip this node without removing it.',
  description:
    'Turn this node off without deleting it from the graph. Absent is ENABLED. A disabled node is SKIPPED observably by both runtimes — never a silent no-op. A mandatory node may be disabled but never REMOVED (TASK-890 D-1): publish records a `GUARDRAIL_OPTED_OUT` warning and every run records `guardrail: "opted_out"`. The two graph boundaries (`core.trigger`, `core.output`) do not offer it — a graph with no entry or no exit cannot run at all.',
});

/** The palette-agnostic runtime knobs folded onto every node type: the two keys `compileNode`
 *  reads off every node`s config, plus the `enabled` toggle both RUNTIMES read off it. */
const NODE_RUNTIME_PROPERTIES: Readonly<Record<string, NodeConfigSchema>> = Object.freeze({
  timeoutSeconds: Object.freeze({
    type: 'integer',
    minimum: 1,
    summary: 'How many seconds this node gets before it times out.',
    description: 'Per-node execution budget in seconds, clamped to the definition`s `caps.maxNodeSeconds` at compile time.',
  }),
  retry: NODE_RETRY_SCHEMA,
  enabled: NODE_ENABLED_PROPERTY,
});

// The per-node `llmBinding` (DD-10) used to be folded in here by `withLlmBinding()` onto every
// schema declaring `taskKey`. TASK-882 removed it: since TASK-876 the TEXT_GENERATION agent
// selects the model and no runtime read the binding (`api_client.py`, `_llm_policy.py`), so the
// property was a configuration promise nothing kept. Model selection is the agent's alone.

/**
 * EMPTY since TASK-893 Phase 4, and deliberately kept rather than deleted.
 *
 * Its one member was `consultation.hitlGate`, the only `gate`-classed node type: the compiler
 * lifted it out of `stages` into `gates` and routed it through `compileGate`, which reads
 * `timeoutSeconds` (declared on its own schema, scoped to the human wait) and NO retry policy at
 * all — `CompiledGate` has no `retry` field, so offering one would have been a configuration
 * promise the runtime cannot keep. That node type left the vocabulary with the legacy palettes;
 * the durable human wait is now `core.humanReview`, which is `review`-classed and compiles as an
 * ordinary stage, so it takes the runtime fold like every other node.
 *
 * The hook stays because the CONDITION it encodes is still live: a node type whose config the
 * COMPILER consumes rather than an activity cannot be offered knobs the compiled artifact has no
 * field for. The next such type belongs here, not in a fresh carve-out.
 */
const RUNTIME_PROPERTY_EXCLUSIONS: ReadonlySet<string> = new Set<string>();

/**
 * The node types the rule catalogue requires to be PRESENT on every path from `core.start` to a
 * terminal (`REQUIRED_PATH_THROUGH` with `throughClass: 'mandatory'` — *"nothing routes around a
 * gate"*).
 *
 * ## What `mandatory` means, after TASK-890 D-1 (owner decision, 2026-09-06)
 *
 * It means the node must BE THERE. It no longer means it must EXECUTE.
 *
 * This set used to gate the `enabled` fold below, so the seven clinical guard types offered no
 * disable toggle at all, and the argument recorded here was that a switchable
 * `consultation.consentGate` is a compliance defect rather than a feature. The owner decided
 * otherwise: guardrail screening is platform-managed and a tenant may opt OUT of it per agent,
 * per workflow and per node (OD-R), and that opt-out extends to the mandatory clinical guards
 * (D-1). The safety property is not the absence of a switch — it is that using the switch is
 * IMPOSSIBLE TO DO QUIETLY. Three compensating controls carry it:
 *
 *   1. publish emits `GUARDRAIL_OPTED_OUT` (a WARNING, never blocking) naming every disabled
 *      mandatory node by id and type, so it shows in the Studio rail, in the agent findings and
 *      on `validationReport` afterwards (`publish-findings.ts`);
 *   2. every run of such a graph records `attributesJson.guardrail: 'opted_out'` on the usage row
 *      and a `SKIPPED(disabled_by_config)` step result carrying the node id, so "this
 *      consultation ran without its consent gate" is a query, not an inference from graph JSON;
 *   3. PRESENCE is untouched — publish still REFUSES a graph in which the node was deleted. The
 *      opt-out is a switch, never a deletion.
 *
 * `GRAPH_BOUNDARY_NODE_TYPES` below is what still withholds the toggle, for a structural reason
 * rather than a clinical one. And `consultation.hitlGate` — the human sign-off — gains nothing
 * from D-1: it is the one `gate`-classed type and sits in `RUNTIME_PROPERTY_EXCLUSIONS` above,
 * which returns its schema BEFORE the runtime fold is reached (TASK-859 invariant 5, *"the system
 * never signs"*: D-1 is about which nodes may be SKIPPED, never about who DECIDES).
 *
 * ## Why the set is a literal here
 *
 * The discriminator is still the class the rule catalogue uses, not a list of node names — this
 * set is duplicated here ONLY because `node-registry.ts` imports THIS module (reading
 * `classesOf()` here would close an import cycle). `__tests__/node-enabled-toggle.task852.test.ts`
 * asserts the two sets are the same one, so the projection cannot drift from the registry it
 * mirrors. It is EXPORTED because `publish-findings.ts` reads it to decide which disabled node
 * earns the `GUARDRAIL_OPTED_OUT` warning above.
 */
export const MANDATORY_NODE_TYPES: ReadonlySet<string> = new Set([
  // TASK-864 — the `core` graph boundaries. A trigger or an output that can be switched off is a
  // graph with no entry or no exit; both carry the `mandatory` class in `node-registry.ts`.
  // TASK-893: the legacy palettes' mandatory clinical guards are gone; a mandatory ACTION
  // (`consultation.consentGate`, `consultation.phiHop`, …) carries `mandatory` in its catalogue
  // entry's classes, resolved per instance by `classesOf('core.action', config)`.
  'core.trigger',
  'core.output',
]);

/**
 * The two node types that still withhold `enabled` (TASK-890 D-1).
 *
 * `core.trigger` and `core.output` are in `MANDATORY_NODE_TYPES` for a STRUCTURAL reason, not a
 * clinical one: a disabled entry is a graph that cannot start and a disabled exit is a graph that
 * cannot deliver. That is an unrunnable graph rather than a guardrail opinion, so withholding the
 * key here costs a tenant nothing and saves the contract from inventing new runtime semantics for
 * a boundary that is off. A subset of `MANDATORY_NODE_TYPES` by construction — asserted.
 */
export const GRAPH_BOUNDARY_NODE_TYPES: ReadonlySet<string> = new Set(['core.trigger', 'core.output']);

function withRuntimeProperties(key: string, schema: NodeConfigSchema): NodeConfigSchema {
  if (RUNTIME_PROPERTY_EXCLUSIONS.has(key)) return schema;
  const declared = (schema.properties ?? {}) as Record<string, NodeConfigSchema>;
  const offered = Object.entries(NODE_RUNTIME_PROPERTIES).filter(([name]) => !(name === 'enabled' && GRAPH_BOUNDARY_NODE_TYPES.has(key)));
  const additions = offered.filter(([name]) => declared[name] === undefined);
  if (additions.length === 0) return schema;
  return Object.freeze({ ...schema, properties: Object.freeze({ ...declared, ...Object.fromEntries(additions) }) });
}

/**
 * The PUBLIC map: every authored schema with the palette-agnostic runtime knobs folded in. This
 * is what `node-registry.ts` attaches as `WorkflowNodeDescriptor.configSchema`, what
 * `GET /admin/workflow-nodes` serves, and what the Studio inspector compiles into fields.
 */
export const NODE_CONFIG_SCHEMAS: Readonly<Record<string, NodeConfigSchema>> = Object.freeze(
  Object.fromEntries(Object.entries(AUTHORED_NODE_CONFIG_SCHEMAS).map(([key, schema]) => [key, withRuntimeProperties(key, schema)])),
);

/**
 * TASK-893 — the config schemas of the 17 ACTIONS behind `core.action` (`action-catalogue.ts`),
 * keyed by action key, with the same runtime knobs folded in as every node schema (the
 * interpreter merges `timeoutSeconds` / `retry` / `onError` from the node into the action's own
 * config). Validated under the node's `action` sub-config (`actionConfigSchemaOf`).
 */
export const ACTION_CONFIG_SCHEMAS: Readonly<Record<string, NodeConfigSchema>> = Object.freeze(
  Object.fromEntries(Object.entries(AUTHORED_ACTION_CONFIG_SCHEMAS).map(([key, schema]) => [key, withRuntimeProperties(key, schema)])),
);
