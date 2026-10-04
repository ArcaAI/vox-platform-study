/**
 * TASK-1036 §3.5 (OD-4 / OD-5 / D-3 / D-4) — `graph.settings`, its validator, the WF-SET
 * implications, and the one-release legacy fallback from `core.trigger.kinds` /
 * `core.output.protocols`.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../graph-model';
import {
  WORKFLOW_CONNECTIONS,
  WORKFLOW_SOURCES,
  effectiveSettings,
  settingsImplications,
  workflowSettingsProblems,
  type WorkflowSettings,
} from '../workflow-settings';

function graphWith(settings: unknown, extraNodes: WorkflowGraph['nodes'] = []): WorkflowGraph & { settings?: unknown } {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } },
      ...extraNodes,
      { id: 'n_output', type: 'core.output', config: { protocols: ['http'] } },
    ],
    edges: [],
    ...(settings === undefined ? {} : { settings }),
  };
}

describe('workflowSettingsProblems — shape', () => {
  it('accepts the declared shape', () => {
    const ok: WorkflowSettings = {
      connections: ['api', 'sse'],
      sources: ['consultation'],
      contextSchema: { contextSchemaId: '79000000-0000-0000-0000-000000000001', versionNumber: null },
    };
    expect(workflowSettingsProblems(ok)).toEqual([]);
    expect(workflowSettingsProblems({ connections: [], sources: [], contextSchema: { inline: { type: 'object' } } })).toEqual([]);
    expect(workflowSettingsProblems({ connections: ['api'], sources: [] })).toEqual([]);
  });

  it.each([
    [null, '/settings'],
    [{ connections: ['ftp'], sources: [] }, '/settings/connections/0'],
    [{ connections: ['api', 'api'], sources: [] }, '/settings/connections'],
    [{ connections: ['api'], sources: ['api'] }, '/settings/sources/0'],
    [{ connections: ['api'] }, '/settings/sources'],
    [{ connections: ['api'], sources: [], extra: 1 }, '/settings/extra'],
    [{ connections: ['api'], sources: [], contextSchema: { contextSchemaId: 'x', versionNumber: 0 } }, '/settings/contextSchema/versionNumber'],
    [{ connections: ['api'], sources: [], contextSchema: { inline: { type: 'object' }, contextSchemaId: 'x' } }, '/settings/contextSchema'],
  ])('refuses %j at %s', (value, pointer) => {
    const problems = workflowSettingsProblems(value);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(pointer);
  });

  it('the vocabularies are the OD-4 split', () => {
    expect(WORKFLOW_CONNECTIONS).toEqual(['api', 'webhook', 'sse', 'socket']);
    expect(WORKFLOW_SOURCES).toEqual(['consultation', 'schedule']);
  });
});

describe('effectiveSettings — settings first, legacy for one release', () => {
  it('reads graph.settings when present and valid', () => {
    const graph = graphWith({ connections: ['socket', 'api'], sources: ['schedule'] });
    expect(effectiveSettings(graph)).toEqual({ connections: ['api', 'socket'], sources: ['schedule'], contextSchema: null, origin: 'settings' });
  });

  it('falls back to trigger kinds and output protocols', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['consultation', 'api', 'webhook', 'schedule'], contextSchema: { contextSchemaId: 'cs-1' } } },
        { id: 'n_output', type: 'core.output', config: { protocols: ['http', 'http-sse', 'socket'] } },
      ],
      edges: [],
    };
    expect(effectiveSettings(graph)).toEqual({
      connections: ['api', 'webhook', 'sse', 'socket'],
      sources: ['consultation', 'schedule'],
      contextSchema: { contextSchemaId: 'cs-1', versionNumber: null },
      origin: 'legacy',
    });
  });

  it('an output with no protocols takes the legacy default (`http-sse` -> sse)', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'], contextSchema: { inline: { type: 'object' } } } },
        { id: 'n_output', type: 'core.output', config: {} },
      ],
      edges: [],
    };
    expect(effectiveSettings(graph)).toMatchObject({ connections: ['api', 'sse'], contextSchema: { inline: { type: 'object' } } });
  });

  it('settings without a contextSchema still take the trigger`s, and an invalid settings block falls back whole', () => {
    const graph = graphWith({ connections: ['api'], sources: [] });
    graph.nodes[0] = { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'], contextSchema: { contextSchemaId: 'cs-2', versionNumber: 3 } } };
    expect(effectiveSettings(graph).contextSchema).toEqual({ contextSchemaId: 'cs-2', versionNumber: 3 });
    expect(effectiveSettings(graphWith({ connections: 'api' })).origin).toBe('legacy');
  });
});

describe('settingsImplications — WF-SET-001..004', () => {
  const settings = (connections: WorkflowSettings['connections']): WorkflowSettings => ({ connections, sources: [] });

  it('WF-SET-001: sse needs api', () => {
    expect(settingsImplications(graphWith(undefined), settings(['sse'])).map((entry) => entry.ruleId)).toEqual(['WF-SET-001']);
    expect(settingsImplications(graphWith(undefined), settings(['sse', 'api']))).toEqual([]);
  });

  it('WF-SET-002: socket needs api', () => {
    expect(settingsImplications(graphWith(undefined), settings(['socket'])).map((entry) => entry.ruleId)).toEqual(['WF-SET-002']);
  });

  it('WF-SET-003: an ASR or TTS agent node needs socket (task from the resolver)', () => {
    const graph = graphWith(undefined, [{ id: 'n_asr', type: 'core.agent', config: { agentRef: { slug: 'asr' } } }]);
    const agents = { asr: { task: 'SPEECH_TO_TEXT' as const } };
    const found = settingsImplications(graph, settings(['api']), { agents });
    expect(found.map((entry) => entry.ruleId)).toEqual(['WF-SET-003']);
    expect(found[0]?.nodeId).toBe('n_asr');
    expect(found[0]?.requires).toBe('socket');
    expect(settingsImplications(graph, settings(['api']), {})).toEqual([]);
    expect(settingsImplications(graph, settings(['api', 'socket']), { agents })).toEqual([]);
  });

  it('WF-SET-003: a stream audio kind in the Input shape needs socket', () => {
    const definition = { schemaVersion: '1.0', kinds: [{ key: 'audio_stream', primitive: 'STREAM_AUDIO' }] };
    expect(settingsImplications(graphWith(undefined), settings(['api']), { contextSchemaDefinition: definition }).map((entry) => entry.ruleId)).toEqual([
      'WF-SET-003',
    ]);
  });

  it('WF-SET-004: blob audio or an attachment needs api', () => {
    const blob = { schemaVersion: '1.0', kinds: [{ key: 'recording', primitive: 'STREAM_AUDIO', delivery: 'blob' }] };
    const attachment = { schemaVersion: '1.0', kinds: [{ key: 'attachment', primitive: 'DOCUMENT' }] };
    expect(settingsImplications(graphWith(undefined), settings(['webhook']), { contextSchemaDefinition: blob }).map((entry) => entry.ruleId)).toEqual([
      'WF-SET-004',
    ]);
    expect(
      settingsImplications(graphWith(undefined), settings(['webhook']), { contextSchemaDefinition: attachment }).map((entry) => entry.ruleId),
    ).toEqual(['WF-SET-004']);
    expect(settingsImplications(graphWith(undefined), settings(['api']), { contextSchemaDefinition: attachment })).toEqual([]);
  });

  it('every implication names what it requires and why, in plain language', () => {
    for (const entry of settingsImplications(graphWith(undefined), settings(['sse', 'socket']))) {
      expect(entry.message).toMatch(/needs the API connection/);
      expect(entry.requires).toBe('api');
    }
  });
});
