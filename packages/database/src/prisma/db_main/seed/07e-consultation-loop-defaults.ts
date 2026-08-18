/**
 * The day-1 default consultation context schema, and the loop
 * configuration the seeded default agents carry.
 *
 * ## Why this file exists
 *
 * A prior change turned the SIGNALLING gate on (that gate is now the `agenticLoop`
 * subscription entitlement composed with `harness.loop.emergencyStop` — TASK-705), so a real
 * `context.added` now starts `ConsultationLoopWorkflow`. The workflow then
 * completed `phase: "DISABLED"`, because its pinned config's `enabled` is
 * DERIVED, never stored
 * (`packages/applications/src/services/consultation/loop/loop-config.service.ts`):
 *
 *     const enabled = agentConfigVersionId !== null || contextSchemaVersionId !== null;
 *
 * Neither existed on a fresh install. This file creates both, coherently: a
 * servable `ConsultationContextSchema` + `Version` per seeded tenant, and (via
 * `07a-agent-golden-library.ts`, which imports `DAY1_AGENT_LOOP_CONFIG` from
 * here) the matching loop configuration on every seeded default agent.
 *
 * ## The vocabulary
 *
 * The owner's worked example E1 — "a consultation schema that: audio stream,
 * work note, case note, attachment" — mapped onto the five platform primitives
 * of Nothing beyond E1 is declared: every kind here becomes the
 * platform's default clinical vocabulary for every tenant, so the bar for
 * adding one is a producer that actually exists.
 *
 *   audio_stream → STREAM_AUDIO   the STT session + AudioRecording
 *   work_note    → TEXT           today's WORKNOTE ContextItem
 *   case_note    → TEXT           today's CASE_NOTE ContextItem
 *   attachment   → DOCUMENT       today's ATTACHMENT ContextItem (Media + OCR)
 *
 * A single output, `soap_note` — the note `harness.finalize` produces. It is
 * `TEXT`, not `STRUCTURED`: the note the harness writes is markdown, and
 * declaring `STRUCTURED` would promise a field schema the platform does not
 * have. `key_finding` / `gate_status` are deliberately NOT declared — no code
 * path produces either, and unbacked vocabulary in a day-1 default is a promise
 * the platform cannot keep.
 *
 * ## What the agent subscribes to, and what it deliberately does not
 *
 * `DAY1_AGENT_LOOP_CONFIG.subscribedKinds` names `work_note`, `case_note` and
 * `attachment` — but NOT `audio_stream`, even though the schema declares it.
 * `LoopConfigService.deriveStartAndEndingActions` adds `livedoc.start` /
 * `livedoc.stop` as soon as ANY subscribed kind resolves to `STREAM_AUDIO`, and
 * the LiveDoc lifecycle is already owned end-to-end by
 * `apps/api/src/modules/consultation/consultation.controller.ts`
 * (`recording/start` → `liveDocumentationService.start`, `recording/stop` →
 * `.stop`). Subscribing it would issue a SECOND start and a SECOND stop per
 * consultation on every fresh install. The kind is the tenant's vocabulary and
 * belongs in the schema; arming the action is a tenant decision, made in the
 * console.
 *
 * ## Idempotency
 *
 * CREATE-ONLY, in both halves, following `05c-platform-storage-config.ts`:
 *
 *  - the context schema is created only when neither the seeded row NOR any
 *    other default TENANT-scoped schema exists for that tenant — a re-seed never
 *    reverts an operator's definition, pin, status or `isDefault` flip, and never
 *    creates a second default (which the application-layer "at most one default
 *    per (tenant, scope, department)" rule forbids);
 *  - the agent loop-config columns are FILL-IF-ABSENT (`07a`): written only onto
 *    rows that carry no loop configuration at all. That is what lets an already-
 *    seeded database pick the defaults up on its next seed while leaving a tenant
 *    admin's own configuration untouched.
 *
 * ## No dependency on @arcaai/applications
 *
 * `packages/database` must not import `@arcaai/applications` — that would close
 * a cycle (applications → domains → database). The two canonicalisers below are
 * therefore verbatim copies of `canonicalJson` / `computeDefinitionChecksum`
 * (`consultation-context-schema/context-schema-definition.ts`) and
 * `canonicalAgentConfigJson` / `buildLoopConfigSnapshot` / `hasLoopConfig`
 * (`departmentAgent/constants.ts`). `day1-loop-defaults.task686.test.ts` in
 * `packages/applications` asserts checksum parity against the real ones, so the
 * copies cannot drift silently.
 *
 * ID blocks (registered in 00-constants.ts):
 *   79000000-…-XXXX-…  Consultation context schemas       (slot = tenant, as 78000000)
 *   89000000-…-XXXX-…  their published version snapshots  (mirror slot)
 *   D0000000-…         DepartmentAgentVersion rows        (derived from the agent id)
 */
import { createHash } from 'node:crypto';

import type { CorePrismaClient } from '../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

// =============================================================================
// Canonicalisers — verbatim copies (see the file header)
// =============================================================================

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Copy of `canonicalJson` — object keys sorted, array order preserved. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Copy of `computeDefinitionChecksum`. */
export const definitionChecksum = (definition: unknown): string => createHash('sha256').update(canonicalJson(definition)).digest('hex');

/** The seven loop-config fields a `DepartmentAgent` may carry. */
export interface AgentLoopConfigSeed {
  role: string;
  subscribedKinds: Record<string, unknown>;
  writeScope: Record<string, unknown>;
  goal: Record<string, unknown>;
  guardrailProfile: string;
  alwaysActions: string[] | null;
  neverActions: string[] | null;
}

/**
 * The same seven fields as they arrive from a seed row or a database row —
 * every one optional and nullable, because that is what an unconfigured agent
 * actually looks like.
 */
export interface AgentLoopConfigInput {
  role?: string | null;
  subscribedKinds?: Record<string, unknown> | null;
  writeScope?: Record<string, unknown> | null;
  goal?: Record<string, unknown> | null;
  guardrailProfile?: string | null;
  alwaysActions?: string[] | null;
  neverActions?: string[] | null;
}

/** Copy of `buildLoopConfigSnapshot`. */
export function buildLoopConfigSnapshot(config: AgentLoopConfigInput): Record<string, unknown> {
  return {
    role: config.role ?? 'SPECIALIST',
    subscribedKinds: config.subscribedKinds ?? null,
    writeScope: config.writeScope ?? null,
    goal: config.goal ?? null,
    guardrailProfile: config.guardrailProfile ?? null,
    alwaysActions: config.alwaysActions ?? null,
    neverActions: config.neverActions ?? null,
  };
}

/** Copy of `hasLoopConfig`, applied to a seed row / a DB row. */
export function seedRowHasLoopConfig(config: AgentLoopConfigInput): boolean {
  const snapshot = buildLoopConfigSnapshot(config);
  return (
    snapshot.role !== 'SPECIALIST' ||
    snapshot.subscribedKinds !== null ||
    snapshot.writeScope !== null ||
    snapshot.goal !== null ||
    snapshot.guardrailProfile !== null ||
    (Array.isArray(snapshot.alwaysActions) && snapshot.alwaysActions.length > 0) ||
    (Array.isArray(snapshot.neverActions) && snapshot.neverActions.length > 0)
  );
}

/** sha256 over the canonical loop-config snapshot — `DepartmentAgentService`'s no-op-write guard. */
export const agentLoopConfigChecksum = (config: AgentLoopConfigInput): string =>
  createHash('sha256').update(canonicalJson(buildLoopConfigSnapshot(config))).digest('hex');

// =============================================================================
// The day-1 definition (owner example E1)
// =============================================================================

export const DAY1_CONTEXT_SCHEMA_SLUG = 'consultation_default';

export const DAY1_CONTEXT_SCHEMA_DEFINITION: Record<string, unknown> = {
  schemaVersion: '1.0',
  kinds: [
    {
      key: 'audio_stream',
      label: 'Audio Stream',
      primitive: 'STREAM_AUDIO',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'DURING',
      producedBy: ['CLIENT'],
      description: 'The live consultation recording, captured by the STT session.',
    },
    {
      key: 'work_note',
      label: 'Work Note',
      primitive: 'TEXT',
      phiClass: 'PHI',
      cardinality: 'MANY',
      lifecycle: 'ANY',
      producedBy: ['CLIENT'],
      description: "The clinician's own working notes for this consultation.",
    },
    {
      key: 'case_note',
      label: 'Case Note',
      primitive: 'TEXT',
      phiClass: 'PHI',
      cardinality: 'MANY',
      lifecycle: 'ANY',
      producedBy: ['CLIENT'],
      description: 'Clinical case notes contributed during or around the consultation.',
    },
    {
      key: 'attachment',
      label: 'Attachment',
      primitive: 'DOCUMENT',
      phiClass: 'PHI',
      cardinality: 'MANY',
      lifecycle: 'ANY',
      producedBy: ['CLIENT'],
      description: 'A document attached to the consultation; its text is extracted before use.',
    },
  ],
  outputs: [
    {
      key: 'soap_note',
      label: 'SOAP Note',
      primitive: 'TEXT',
      description: 'The clinical note produced by the documentation harness.',
    },
  ],
};

// =============================================================================
// The day-1 agent loop configuration
// =============================================================================

export const DAY1_AGENT_LOOP_CONFIG: AgentLoopConfigSeed = {
  // One seeded default agent per department, so PRIMARY never contests another
  // (AC-7). With no SPECIALIST alongside it the deliberative lane stays
  // OFF, which is exactly 's behaviour.
  role: 'PRIMARY',
  // `audio_stream` is deliberately absent — see the file header.
  subscribedKinds: {
    version: 1,
    kinds: [{ key: 'work_note' }, { key: 'case_note' }, { key: 'attachment' }],
  },
  writeScope: { version: 1, outputs: ['soap_note'] },
  goal: {
    version: 1,
    objective: 'Maintain an accurate, grounded clinical note for this consultation from the context the clinician contributes.',
    successCriteria: [
      'Every statement in the note is supported by contributed context.',
      'Attached documents are read before the note is finalized.',
    ],
  },
  guardrailProfile: 'STANDARD',
  alwaysActions: null,
  neverActions: null,
};

// =============================================================================
// Rows
// =============================================================================

/**
 * Tenant → id slot, mirroring the `78000000-…-XXXX-…` DepartmentAgent
 * convention so a row's owner is readable straight off its id.
 */
const TENANT_ID_SLOTS: Array<{ tenantId: string; slot: string }> = [
  { tenantId: SYSTEM_TENANT_ID, slot: '0002' },
  { tenantId: SEED_TENANT_ID, slot: '0000' },
  { tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI, slot: '0001' },
];

export const DAY1_CONTEXT_SCHEMAS = TENANT_ID_SLOTS.map(({ tenantId, slot }) => ({
  id: `79000000-0000-0000-${slot}-000000000001`,
  tenantId,
  slug: DAY1_CONTEXT_SCHEMA_SLUG,
  name: 'Default Consultation Context',
  description:
    'Platform day-1 consultation context vocabulary: audio stream, work note, case note and attachment, producing a SOAP note. Editable by a tenant admin; a re-seed never overwrites it.',
  scope: 'TENANT' as const,
  departmentId: null as string | null,
  status: 'PUBLISHED' as const,
  pinnedVersionNumber: 1,
  isDefault: true,
  sourceTemplateSlug: null as string | null,
  templateLocked: false,
  resourceStatus: 'ENABLED' as const,
  createdBy: SYSTEM_USER_ID,
}));

export const DAY1_CONTEXT_SCHEMA_VERSIONS = TENANT_ID_SLOTS.map(({ tenantId, slot }) => ({
  id: `89000000-0000-0000-${slot}-000000000001`,
  tenantId,
  schemaId: `79000000-0000-0000-${slot}-000000000001`,
  versionNumber: 1,
  definition: DAY1_CONTEXT_SCHEMA_DEFINITION,
  checksum: definitionChecksum(DAY1_CONTEXT_SCHEMA_DEFINITION),
  changeReason: 'Day-1 platform default consultation context vocabulary',
  createdBy: SYSTEM_USER_ID,
}));

/**
 * A `DepartmentAgentVersion` id derived 1:1 from its agent's id — the agent ids
 * are already unique and carry their own tenant slot, so a parallel numbering
 * scheme would only be one more thing to keep in step.
 */
export const agentVersionIdFor = (agentId: string): string => `D0000000${agentId.slice(8)}`;

// =============================================================================
// Seed function
// =============================================================================

export const seedConsultationLoopDefaults = async (client: CorePrismaClient) => {
  console.log('Seeding day-1 consultation context schema (TASK-686)...');

  let created = 0;
  let skipped = 0;

  for (const [index, schema] of DAY1_CONTEXT_SCHEMAS.entries()) {
    const version = DAY1_CONTEXT_SCHEMA_VERSIONS[index];
    if (!version) throw new Error(`Missing day-1 context schema version for ${schema.id}`);

    // CREATE-ONLY, on TWO conditions: the seeded row itself, and any OTHER
    // default TENANT-scoped schema the tenant may already own. The second check
    // is the application-layer "at most one default per (tenant, scope,
    // departmentId)" rule — the DB cannot express it (a partial unique index
    // over ENABLED rows only), so the seed has to honour it explicitly.
    const existing = await client.consultationContextSchema.findFirst({
      where: {
        tenantId: schema.tenantId,
        OR: [{ id: schema.id }, { scope: 'TENANT', departmentId: null, isDefault: true, resourceStatus: 'ENABLED' }],
      },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    await client.consultationContextSchema.create({ data: schema });
    await client.consultationContextSchemaVersion.create({
      data: { ...version, definition: version.definition as never },
    });
    created += 1;
  }

  console.log(`Seeded ${created} day-1 context schema(s) + version(s); ${skipped} left untouched (already present or tenant-configured)`);
};
