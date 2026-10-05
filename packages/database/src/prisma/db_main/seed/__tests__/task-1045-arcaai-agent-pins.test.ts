/**
 * TASK-1045 E2E-17 — a fresh seed must leave every ArcaAI workflow pinning the agent version that
 * is ACTIVE in the tenant.
 *
 * A published workflow freezes `agentRef.versionNumber` for every `core.agent` node (TASK-1036 W3),
 * and both runtimes refuse a pin that is not the active published version (the live lane's
 * `AGENT_VERSION_DRIFT`, the harness's `agent_version_mismatch`). The seeded workflows are
 * compiled against "every seeded agent row is version 1" (`regen-workflow-seeds.ts`). Phase 07g
 * then bound ArcaAI's `realtime-transcription` to its transcription schema by BRANCHING v2 off the
 * phase-26 clone, so on a fresh database all 11 `arcaai-*-consultation` workflows and the cloned
 * `general-medicine-consultation` pinned v1 of an agent whose active version was v2: every
 * realtime flush degraded `n_asr`, and the live note stayed empty for the whole consultation.
 *
 * This replays the seed phases in their real order (25 → 28 → 29 → 26 → 07g, `index.ts`) against
 * an in-memory store and checks the invariant on what they leave behind — twice, so a re-seed is
 * held to it as well.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { SEED_ARCAAI_CONTEXT_SCHEMA_IDS, SEED_CUSTOMER_TENANT_IDS } from '../00-constants';
import { DEFAULT_AI_MODELS } from '../06-ai-models';
import { seedConsultationNoteContextSchema } from '../07e-consultation-note-context-schema';
import { ARCAAI_REALTIME_TRANSCRIPTION_FROZEN_CONTEXT_SCHEMA, seedArcaaiTwoContextSchemas } from '../07g-arcaai-two-schemas';
import { seedDefaultIoContextSchema } from '../07h-default-io-context-schema';
import { ASR_AGENT_SLUG, PLATFORM_AGENT_SPECS, canonicalJson, seedAgents } from '../25-agents';
import { provisionTenantReferenceSet } from '../26-tenant-reference-set';
import { createWorkflowDefinitions, workflowLibraryDefinitions } from '../28-workflow-library';
import { ARCAAI_DEPARTMENT_TABLE, ARCAAI_WORKFLOW_TARGETS, seedArcaaiAgentsAndWorkflows } from '../29-arcaai-agents-and-workflows';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const ARCAAI = SEED_CUSTOMER_TENANT_IDS.ARCAAI;

// -------------------------------------------------------------------------------------------------
// A small in-memory Prisma: enough of `where` / `orderBy` / `data` for the seed phases replayed here.
// -------------------------------------------------------------------------------------------------

const DEFAULTS: Row = { resourceStatus: 'ENABLED', version: 1 };

function matchValue(actual: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
    const c = condition as Row;
    if ('in' in c) return (c.in as unknown[]).includes(actual);
    if ('notIn' in c) return !(c.notIn as unknown[]).includes(actual);
    if ('not' in c) return !matchValue(actual, c.not);
    if ('equals' in c) return matchValue(actual, c.equals);
    if ('has' in c) return Array.isArray(actual) && actual.includes(c.has);
    if ('hasSome' in c) return Array.isArray(actual) && (c.hasSome as unknown[]).some((v) => actual.includes(v));
    if ('startsWith' in c) return typeof actual === 'string' && actual.startsWith(c.startsWith as string);
    if ('contains' in c) return typeof actual === 'string' && actual.includes(c.contains as string);
    if ('lt' in c || 'lte' in c || 'gt' in c || 'gte' in c) {
      const a = actual as any;
      return (!('lt' in c) || a < c.lt) && (!('lte' in c) || a <= c.lte) && (!('gt' in c) || a > c.gt) && (!('gte' in c) || a >= c.gte);
    }
    // A compound unique key (`tenantId_slug: { … }`) or a nested relation filter we do not model.
    return Object.entries(c).every(([key, value]) => matchValue((actual as Row | undefined)?.[key], value));
  }
  if (actual === undefined) return condition === null;
  return actual === condition;
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return (condition as Row[]).some((sub) => matches(row, sub));
    if (key === 'AND') return (condition as Row[]).every((sub) => matches(row, sub));
    if (key === 'NOT') return ![condition].flat().some((sub) => matches(row, sub as Row));
    // A compound unique key flattens onto the row (`tenantId_slug: { tenantId, slug }`).
    if (key.includes('_') && condition !== null && typeof condition === 'object' && !(key in row)) {
      return matches(row, condition as Row);
    }
    return matchValue(row[key], condition);
  });
}

function applyData(row: Row, data: Row): Row {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const op = value as Row;
      if ('increment' in op) {
        row[key] = (row[key] ?? 0) + op.increment;
        continue;
      }
      if ('set' in op) {
        row[key] = op.set;
        continue;
      }
    }
    row[key] = value;
  }
  return row;
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  const keys = [orderBy ?? []].flat() as Row[];
  return [...rows].sort((a, b) => {
    for (const spec of keys) {
      for (const [key, dir] of Object.entries(spec)) {
        if (a[key] === b[key]) continue;
        const less = a[key] < b[key] ? -1 : 1;
        return dir === 'desc' ? -less : less;
      }
    }
    return 0;
  });
}

function createStore() {
  const tables = new Map<string, Row[]>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const copy = (row: Row | undefined | null) => (row ? { ...row } : null);
  const insert = (name: string, data: Row) => {
    const row = applyData({ ...DEFAULTS, id: randomUUID() }, data);
    table(name).push(row);
    return { ...row };
  };
  const delegate = (name: string) => ({
    findUnique: async ({ where }: Row) => copy(table(name).find((row) => matches(row, where))),
    findUniqueOrThrow: async ({ where }: Row) => {
      const row = table(name).find((r) => matches(r, where));
      if (!row) throw new Error(`${name}: no row`);
      return copy(row);
    },
    findFirst: async ({ where, orderBy }: Row = {}) =>
      copy(
        sortRows(
          table(name).filter((row) => matches(row, where)),
          orderBy,
        )[0],
      ),
    findMany: async ({ where, orderBy }: Row = {}) =>
      sortRows(
        table(name).filter((row) => matches(row, where)),
        orderBy,
      ).map((row) => ({ ...row })),
    count: async ({ where }: Row = {}) => table(name).filter((row) => matches(row, where)).length,
    create: async ({ data }: Row) => insert(name, data),
    createMany: async ({ data }: Row) => {
      for (const row of data as Row[]) insert(name, row);
      return { count: (data as Row[]).length };
    },
    update: async ({ where, data }: Row) => {
      const row = table(name).find((r) => matches(r, where));
      if (!row) throw new Error(`${name}.update: no row`);
      return { ...applyData(row, data) };
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = table(name).filter((r) => matches(r, where));
      for (const row of rows) applyData(row, data);
      return { count: rows.length };
    },
    upsert: async ({ where, create, update }: Row) => {
      const row = table(name).find((r) => matches(r, where));
      return row ? { ...applyData(row, update) } : insert(name, create);
    },
  });

  const delegates = new Map<string, ReturnType<typeof delegate>>();
  const client: any = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === '$transaction') {
          return async (work: unknown) => (typeof work === 'function' ? (work as (tx: unknown) => unknown)(client) : Promise.all(work as unknown[]));
        }
        if (prop === 'then') return undefined;
        if (!delegates.has(prop)) delegates.set(prop, delegate(prop));
        return delegates.get(prop);
      },
    },
  );
  return { client, rows: table };
}

// -------------------------------------------------------------------------------------------------
// The replay
// -------------------------------------------------------------------------------------------------

function seededStore() {
  const store = createStore();
  // The SYSTEM model catalogue the agents bind by slug (`06-ai-models`), and approved prompt
  // templates for every template an instruction pins (`07*`).
  for (const model of DEFAULT_AI_MODELS) {
    store.rows('aiModel').push({
      ...DEFAULTS,
      id: `model:${model.slug}`,
      tenantId: '00000000-0000-0000-0000-000000000000',
      slug: model.slug,
      taskType: String(model.taskType),
      provider: model.provider ?? null,
      wireModelId: null,
    });
  }
  const templates = new Proxy(store.client.promptTemplate, {
    get(target, prop: string) {
      if (prop === 'findUnique') {
        return async ({ where }: Row) =>
          (await target.findUnique({ where })) ?? {
            id: where.id,
            status: 'APPROVED',
            content: `content of ${where.id}`,
            approvedVersionNumber: 1,
            currentVersionNumber: 1,
          };
      }
      return (target as Row)[prop];
    },
  });
  const versions = new Proxy(store.client.promptVersion, {
    get(target, prop: string) {
      if (prop === 'findFirst') return async (args: Row) => (await target.findFirst(args)) ?? { content: 'versioned content', variables: null };
      return (target as Row)[prop];
    },
  });
  const client: any = new Proxy(store.client, {
    get(target, prop: string) {
      if (prop === 'promptTemplate') return templates;
      if (prop === 'promptVersion') return versions;
      return target[prop];
    },
  });
  store.rows('tenant').push({ ...DEFAULTS, id: ARCAAI, key: 'arcaai' });
  for (const row of ARCAAI_DEPARTMENT_TABLE)
    store.rows('department').push({ ...DEFAULTS, id: `department:${row.code}`, tenantId: ARCAAI, code: row.code });
  return { client, rows: store.rows };
}

/** `index.ts` order: 07e/07h (schemas) → 25 (agents + TENANT assignments) → 28 (library) → 29 (ArcaAI) → 26 (reference set) → 07g. */
async function runSeedPhases(client: any) {
  await seedConsultationNoteContextSchema(client);
  await seedDefaultIoContextSchema(client);
  await seedAgents(client);
  await createWorkflowDefinitions(client, workflowLibraryDefinitions());
  await seedArcaaiAgentsAndWorkflows(client);
  await provisionTenantReferenceSet(client, ARCAAI);
  await seedArcaaiTwoContextSchemas(client);
}

interface Drift {
  workflow: string;
  node: string;
  slug: string;
  pinned: number;
  active: number | null;
}

/** Every `core.agent` pin of every published, active ArcaAI workflow vs the tenant's active published agent. */
function pinDrift(rows: (name: string) => Row[]): { checked: number; drift: Drift[] } {
  const agents = rows('agent').filter(
    (agent) => agent.tenantId === ARCAAI && agent.status === 'PUBLISHED' && agent.isActive && agent.resourceStatus === 'ENABLED',
  );
  const drift: Drift[] = [];
  let checked = 0;
  for (const workflow of rows('workflowDefinition')) {
    if (workflow.tenantId !== ARCAAI || workflow.status !== 'PUBLISHED' || !workflow.isActive) continue;
    for (const stage of (workflow.compiledConfig?.stages ?? []) as Row[]) {
      for (const node of (stage.nodes ?? []) as Row[]) {
        const ref = node.config?.agentRef as { slug?: string; versionNumber?: number } | undefined;
        if (node.type !== 'core.agent' || ref?.slug === undefined || ref.versionNumber === undefined) continue;
        checked += 1;
        const active = agents.filter((agent) => agent.slug === ref.slug);
        const activeVersion = active.length === 1 ? (active[0]!.versionNumber as number) : null;
        if (activeVersion !== ref.versionNumber) {
          drift.push({ workflow: workflow.slug, node: node.nodeId, slug: ref.slug, pinned: ref.versionNumber, active: activeVersion });
        }
      }
    }
  }
  return { checked, drift };
}

describe('seeded ArcaAI workflows pin the agent version that is active (E2E-17)', () => {
  it('a fresh seed leaves no `core.agent` pin drifting from the active published version', async () => {
    const { client, rows } = seededStore();
    await runSeedPhases(client);

    const workflows = rows('workflowDefinition')
      .filter((row) => row.tenantId === ARCAAI)
      .map((row) => row.slug);
    for (const target of ARCAAI_WORKFLOW_TARGETS) expect(workflows).toContain(target.slug);
    expect(workflows).toContain('general-medicine-consultation');

    const { checked, drift } = pinDrift(rows);
    expect(checked).toBeGreaterThan(ARCAAI_WORKFLOW_TARGETS.length * 5);
    expect(drift).toEqual([]);
  });

  it('seeds ArcaAI `realtime-transcription` ONCE, already bound to the transcription schema', async () => {
    const { client, rows } = seededStore();
    await runSeedPhases(client);

    const versions = rows('agent').filter((row) => row.tenantId === ARCAAI && row.slug === ASR_AGENT_SLUG);
    expect(versions.map((row) => row.versionNumber)).toEqual([1]);
    const [agent] = versions;
    expect(agent).toMatchObject({ status: 'PUBLISHED', isActive: true, task: 'SPEECH_TO_TEXT' });
    expect(agent!.contextSchemaId).toBe(SEED_ARCAAI_CONTEXT_SCHEMA_IDS.REALTIME_TRANSCRIPTION);
    expect(agent!.contextSchemaVersionNumber).toBe(1);
    expect(canonicalJson(agent!.compiledConfig.contextSchema)).toBe(canonicalJson(ARCAAI_REALTIME_TRANSCRIPTION_FROZEN_CONTEXT_SCHEMA));

    // The platform row it stands in for: same model, fallback chain and authored config.
    const platform = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === ASR_AGENT_SLUG)!;
    expect(agent!.modelId).toBe(`model:${platform.modelSlug}`);
    expect(agent!.parameters).toEqual(platform.parameters);
    const fallbacks = rows('agentModelFallback')
      .filter((row) => row.agentId === agent!.id)
      .sort((a, b) => a.priority - b.priority)
      .map((row) => row.modelId);
    expect(fallbacks).toEqual(platform.fallbackModelSlugs.map((slug) => `model:${slug}`));

    // The tenant's TENANT-scope SPEECH_TO_TEXT assignment still resolves to it.
    expect(rows('agentAssignment').some((row) => row.tenantId === ARCAAI && row.task === 'SPEECH_TO_TEXT' && row.agentSlug === ASR_AGENT_SLUG)).toBe(
      true,
    );
  });

  it('a re-seed branches nothing and keeps the pins in step', async () => {
    const { client, rows } = seededStore();
    await runSeedPhases(client);
    const before = rows('agent').length;
    await runSeedPhases(client);

    expect(rows('agent').length).toBe(before);
    expect(pinDrift(rows).drift).toEqual([]);
  });
});
