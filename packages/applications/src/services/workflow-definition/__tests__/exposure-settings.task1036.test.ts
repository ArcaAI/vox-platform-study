/**
 * TASK-1036 lane B3b (§3.5, OD-4) — settings-gated exposure, as a PURE helper the exposure plane
 * (lane B3a) calls. Reads the COMPILED settings first (`compiledConfig.settings`, emitted under the
 * data contract), then the stored graph's `settings`, then the legacy trigger kinds / output
 * protocols — and answers whether one entry point may start (or stream) a run.
 */
import { describe, expect, it } from 'vitest';
import { effectiveExposureSettings, isWorkflowEntryAllowed } from '../exposure-settings';

const legacyGraph = (kinds: string[], protocols?: string[]) => ({
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds } },
    { id: 'o1', type: 'core.output', config: protocols === undefined ? {} : { protocols } },
  ],
  edges: [],
});

const compiledFrom = (graph: ReturnType<typeof legacyGraph>, settings?: unknown) => ({
  formatVersion: 1,
  stages: [{ stageIndex: 0, nodes: graph.nodes.map((node) => ({ nodeId: node.id, type: node.type, config: node.config })) }],
  ...(settings === undefined ? {} : { settings }),
});

describe('effectiveExposureSettings', () => {
  it('a compiled config with `settings` wins over everything else', () => {
    const graph = { ...legacyGraph(['api'], ['http']), settings: { connections: ['api', 'sse', 'socket'], sources: [] } };
    const result = effectiveExposureSettings({ compiledConfig: compiledFrom(legacyGraph(['api']), { connections: ['webhook'], sources: ['schedule'] }), graph });
    expect(result).toEqual({ connections: ['webhook'], sources: ['schedule'], origin: 'compiled' });
  });

  it('else the stored graph`s settings', () => {
    const graph = { ...legacyGraph(['api'], ['http']), settings: { connections: ['api', 'sse'], sources: ['consultation'] } };
    expect(effectiveExposureSettings({ compiledConfig: compiledFrom(legacyGraph(['api'])), graph })).toEqual({
      connections: ['api', 'sse'],
      sources: ['consultation'],
      origin: 'settings',
    });
  });

  it('else the legacy trigger kinds and output protocols (one release, D-4)', () => {
    expect(effectiveExposureSettings({ graph: legacyGraph(['api', 'consultation'], ['http', 'socket']) })).toEqual({
      connections: ['api', 'socket'],
      sources: ['consultation'],
      origin: 'legacy',
    });
  });

  it('a compiled config alone derives the legacy answer from its compiled trigger/output configs', () => {
    expect(effectiveExposureSettings(compiledFrom(legacyGraph(['webhook'])))).toEqual({
      connections: ['webhook', 'sse'],
      sources: [],
      origin: 'legacy',
    });
  });

  it('accepts a bare graph too (compiledOrGraph)', () => {
    expect(effectiveExposureSettings(legacyGraph(['api'], ['http'])).connections).toEqual(['api']);
  });

  it('nothing readable ⇒ nothing allowed', () => {
    expect(effectiveExposureSettings(null)).toEqual({ connections: [], sources: [], origin: 'legacy' });
  });
});

describe('isWorkflowEntryAllowed', () => {
  const settings = { connections: ['api', 'sse'] as const, sources: ['consultation'] as const, origin: 'settings' as const };

  it.each([
    ['api', true],
    ['sse', true],
    ['socket', false],
    ['webhook', false],
    ['consultation', true],
    ['schedule', false],
  ] as const)('%s → %s', (entry, allowed) => {
    expect(isWorkflowEntryAllowed({ ...settings, connections: [...settings.connections], sources: [...settings.sources] }, entry)).toBe(allowed);
  });
});
