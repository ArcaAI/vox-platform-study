/**
 * The verdict rule, as a table.
 *
 * `usageVerdict` is the ONE place the platform decides whether publishing (or pinning) a
 * context-schema version breaks a consumer that is bound to it. It is pure on purpose: the
 * service computes it, the console renders it, and the acknowledgement gate refuses on it —
 * three readers that must never disagree about what "refuses" means.
 */
import { describe, it, expect } from 'vitest';
import { agentUsageVerdict, usageVerdict, workflowUsageVerdict } from '../context-schema-usages';

/** The payload schema a target version derives to — `payloadSchemaFromDefinition`'s shape. */
function payloadSchema(...kindKeys: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(kindKeys.map((key) => [key, { type: 'object' }])),
  };
}

/** A compiled workflow config whose `core.trigger` froze `resolved` at version `boundVersion`. */
function compiledWorkflowConfig(...kindKeys: string[]): Record<string, unknown> {
  return {
    formatVersion: 1,
    stages: [
      {
        nodes: [
          {
            id: 'trigger',
            type: 'core.trigger',
            config: { contextSchema: { resolved: payloadSchema(...kindKeys) } },
          },
        ],
      },
    ],
  };
}

describe('usageVerdict — the pure rule', () => {
  it('a FOLLOW-LATEST consumer always accepts: it re-reads the pin at dispatch', () => {
    // Even though the frozen bytes know nothing of `referral`.
    const verdict = usageVerdict({
      binding: 'latest',
      boundVersion: 1,
      targetPayloadSchema: payloadSchema('intake', 'referral'),
      frozenPayloadSchema: payloadSchema('intake'),
    });
    expect(verdict).toEqual({ verdict: 'accepts', problems: [] });
  });

  it('a PINNED consumer accepts when the target declares nothing the bound version lacks', () => {
    const verdict = usageVerdict({
      binding: 'pinned',
      boundVersion: 2,
      targetPayloadSchema: payloadSchema('intake', 'vitals'),
      frozenPayloadSchema: payloadSchema('intake', 'vitals', 'previous_case_notes'),
    });
    expect(verdict).toEqual({ verdict: 'accepts', problems: [] });
  });

  it('a PINNED consumer REFUSES a kind the bound version never declared, naming it', () => {
    const verdict = usageVerdict({
      binding: 'pinned',
      boundVersion: 1,
      targetPayloadSchema: payloadSchema('intake', 'referral'),
      frozenPayloadSchema: payloadSchema('intake'),
    });
    expect(verdict.verdict).toBe('refuses');
    expect(verdict.problems).toEqual(['/referral: not declared in the bound version v1']);
  });

  it('reports EVERY undeclared kind, in the target schema order', () => {
    const verdict = usageVerdict({
      binding: 'pinned',
      boundVersion: 3,
      targetPayloadSchema: payloadSchema('intake', 'referral', 'vitals'),
      frozenPayloadSchema: payloadSchema('intake'),
    });
    expect(verdict.problems).toEqual(['/referral: not declared in the bound version v3', '/vitals: not declared in the bound version v3']);
  });

  it('is UNKNOWN only when the frozen schema cannot be read — never a silent accept', () => {
    const verdict = usageVerdict({
      binding: 'pinned',
      boundVersion: 1,
      targetPayloadSchema: payloadSchema('intake'),
      frozenPayloadSchema: null,
    });
    expect(verdict.verdict).toBe('unknown');
    expect(verdict.problems).toHaveLength(1);
  });
});

describe('workflowUsageVerdict — reading a compiled workflow config', () => {
  it('follows-latest short-circuits, compiled bytes unread', () => {
    const usage = workflowUsageVerdict(
      { contextSchemaFollowsLatest: true, contextSchemaVersionNumber: 1, compiledConfig: null },
      payloadSchema('intake', 'referral'),
    );
    expect(usage).toEqual({ binding: 'latest', boundVersion: 1, verdict: 'accepts', problems: [] });
  });

  it('a PINNED workflow refuses a kind its frozen trigger does not declare', () => {
    const usage = workflowUsageVerdict(
      { contextSchemaFollowsLatest: false, contextSchemaVersionNumber: 1, compiledConfig: compiledWorkflowConfig('intake') },
      payloadSchema('intake', 'referral'),
    );
    expect(usage.binding).toBe('pinned');
    expect(usage.verdict).toBe('refuses');
    expect(usage.problems).toEqual(['/referral: not declared in the bound version v1']);
  });

  it('an unreadable compiled config is UNKNOWN, not a refusal and not an accept', () => {
    const usage = workflowUsageVerdict(
      { contextSchemaFollowsLatest: false, contextSchemaVersionNumber: 2, compiledConfig: { stages: 'not-an-array' } },
      payloadSchema('intake'),
    );
    expect(usage.verdict).toBe('unknown');
  });
});

describe('agentUsageVerdict — an agent pins by column, not by a graph flag', () => {
  it('a NULL contextSchemaVersionNumber means follow-latest', () => {
    const usage = agentUsageVerdict(
      { contextSchemaVersionNumber: null, compiledConfig: { contextSchema: { versionNumber: 1, payloadSchema: payloadSchema('intake') } } },
      payloadSchema('intake', 'referral'),
    );
    expect(usage.binding).toBe('latest');
    expect(usage.verdict).toBe('accepts');
  });

  it('a PINNED agent refuses a kind its frozen payload schema lacks', () => {
    const usage = agentUsageVerdict(
      { contextSchemaVersionNumber: 1, compiledConfig: { contextSchema: { versionNumber: 1, payloadSchema: payloadSchema('intake') } } },
      payloadSchema('intake', 'referral'),
    );
    expect(usage).toEqual({
      binding: 'pinned',
      boundVersion: 1,
      verdict: 'refuses',
      problems: ['/referral: not declared in the bound version v1'],
    });
  });

  it('a pinned agent with no compiled context schema is UNKNOWN', () => {
    const usage = agentUsageVerdict({ contextSchemaVersionNumber: 2, compiledConfig: {} }, payloadSchema('intake'));
    expect(usage.verdict).toBe('unknown');
  });
});
