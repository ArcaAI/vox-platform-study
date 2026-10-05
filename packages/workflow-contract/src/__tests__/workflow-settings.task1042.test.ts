/**
 * TASK-1042 OD-7 — WF-SET-005: a `stream`-delivery Input kind must be READ by a speech-to-text
 * step (`core.agent`, task `SPEECH_TO_TEXT`, its `audio` input), or the integrator streams audio
 * that nothing reads. The Python mirror asserts the SAME `liveAudio` cases of
 * `tests/contracts/workflow-settings.fixture.json`.
 *
 * It is not a connection implication (it names no connection to add), so it is NOT returned by
 * `settingsImplications`, whose every entry the console's settings dialog turns into a locked
 * connection checkbox.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../graph-model';
import { WORKFLOW_PUBLISH_FINDING_CODES, publishFindings, type PublishAgentView, type PublishContext } from '../publish-findings';
import { DATA_CONTRACT_RULES } from '../rule-catalogue';
import { liveAudioUnread, settingsImplications } from '../workflow-settings';

/* eslint-disable @typescript-eslint/no-explicit-any */
const CONTRACTS = path.resolve(__dirname, '../../../../tests/contracts');
const FIXTURE = JSON.parse(readFileSync(path.join(CONTRACTS, 'workflow-settings.fixture.json'), 'utf8'));

describe('liveAudioUnread — workflow-settings.fixture.json `liveAudio`', () => {
  it('exercises both outcomes', () => {
    const expected = FIXTURE.liveAudio.map((entry: any) => entry.expected);
    expect(expected.some((found: unknown[]) => found.length === 0)).toBe(true);
    expect(expected.some((found: unknown[]) => found.length > 0)).toBe(true);
  });

  it.each(FIXTURE.liveAudio.map((entry: any) => [entry.name, entry]))('%s', (_name, entry: any) => {
    const found = liveAudioUnread(entry.graph, entry.settings, entry.context).map((finding) => ({
      ruleId: finding.ruleId,
      nodeId: finding.nodeId,
      kindKey: finding.kindKey,
    }));
    expect(found).toEqual(entry.expected);
  });

  it('names the kind in its message', () => {
    const entry = FIXTURE.liveAudio.find((candidate: any) => candidate.expected.length > 0);
    const found = liveAudioUnread(entry.graph, entry.settings, entry.context);
    expect(found.length).toBeGreaterThan(0);
    for (const finding of found) expect(finding.message).toContain(finding.kindKey);
  });

  it('is never a connection implication', () => {
    for (const entry of FIXTURE.liveAudio) {
      const implications = settingsImplications(entry.graph, entry.settings, entry.context);
      expect(implications.map((implication) => implication.ruleId)).not.toContain('WF-SET-005');
    }
  });
});

// =============================================================================================
// The publish gate
// =============================================================================================

const VIEW: PublishAgentView = { declaredVariables: [], contextPayloadSchema: null };
const AGENTS: Record<string, PublishAgentView> = { asr: { ...VIEW, task: 'SPEECH_TO_TEXT' } };
const DEFINITION = { schemaVersion: '1.0', kinds: [{ key: 'audio_stream', primitive: 'STREAM_AUDIO' }] };
const TRIGGER = { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } };
const OUTPUT = { id: 'n_output', type: 'core.output', config: { protocols: ['http'] } };

function ctx(extra: Partial<PublishContext> = {}): PublishContext {
  return { schemaValueProblems: jsonSchemaValueProblems, agents: AGENTS, contextSchemaDefinition: DEFINITION, ...extra };
}

function graph(asrConfig: Record<string, unknown>, settings?: unknown): WorkflowGraph {
  return {
    version: 1,
    nodes: [TRIGGER, { id: 'n_asr', type: 'core.agent', config: { agentRef: { slug: 'asr' }, ...asrConfig } }, OUTPUT],
    edges: [
      { id: 'e1', from: 'n_trigger', fromPort: 'next', to: 'n_asr', toPort: 'after' },
      { id: 'e2', from: 'n_asr', fromPort: 'next', to: 'n_output', toPort: 'after' },
    ],
    ...(settings === undefined ? {} : { settings }),
  } as WorkflowGraph;
}

const unread = (findings: ReturnType<typeof publishFindings>) => findings.filter((finding) => finding.code === 'SETTINGS_LIVE_AUDIO_UNREAD');

describe('WF-SET-005 reaches the publish gate', () => {
  it('declared settings with an unread streamed input are an ERROR (OD-7)', () => {
    const found = unread(publishFindings(graph({}, { connections: ['api', 'socket'], sources: [] }), ctx()));
    expect(found).toEqual([expect.objectContaining({ ruleId: 'WF-SET-005', code: 'SETTINGS_LIVE_AUDIO_UNREAD', severity: 'ERROR', nodeId: null })]);
    expect(found[0]?.message).toContain('audio_stream');
  });

  it('bound to the speech-to-text step`s audio input, it publishes', () => {
    const g = graph({ inputs: { audio: { from: 'context.audio_stream' } } }, { connections: ['api', 'socket'], sources: [] });
    expect(unread(publishFindings(g, ctx()))).toEqual([]);
  });

  it('a legacy graph (no settings) meets it as a WARNING for one release, like WF-SET-001..004', () => {
    expect(unread(publishFindings(graph({}), ctx())).map((finding) => finding.severity)).toEqual(['WARNING']);
  });

  it('a consultation-sourced workflow is exempt', () => {
    const g = graph({}, { connections: ['api', 'socket'], sources: ['consultation'] });
    expect(unread(publishFindings(g, ctx()))).toEqual([]);
  });

  it('without a resolved Input shape there is nothing to check', () => {
    expect(unread(publishFindings(graph({}, { connections: ['api', 'socket'], sources: [] }), ctx({ contextSchemaDefinition: undefined })))).toEqual(
      [],
    );
  });
});

describe('the catalogue', () => {
  it('catalogues WF-SET-005 as an ERROR with a legacy WARNING, in the publish vocabulary', () => {
    const rule = DATA_CONTRACT_RULES.find((candidate) => candidate.ruleId === 'WF-SET-005');
    expect(rule).toEqual(expect.objectContaining({ code: 'SETTINGS_LIVE_AUDIO_UNREAD', severity: 'ERROR', legacySeverity: 'WARNING' }));
    expect(WORKFLOW_PUBLISH_FINDING_CODES as readonly string[]).toContain('SETTINGS_LIVE_AUDIO_UNREAD');
  });
});
