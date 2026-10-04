/**
 * TASK-1036 C0a — the TypeScript half of the four cross-language data-contract fixtures under
 * `tests/contracts/`. The Python mirror (lane B1) asserts the SAME files, so the two runtimes
 * cannot drift apart about node I/O, bindings, settings or the consultation read schema.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindingIssues, compiledBindings } from '../bindings';
import {
  CONSULTATION_READ_SCHEMA_V1,
  CONSULTATION_READ_SCHEMA_VERSION,
  PLATFORM_CONTEXT_ALIASES,
  consultationReadPaths,
  declaredConsultationReads,
} from '../consultation-read-schema';
import { IO_BASE_TYPES, IO_ELEMENT_TYPES, NODE_IO, agentNodeIO, ioTypeOfJsonSchema, typeFits } from '../node-io';
import { WORKFLOW_CONNECTIONS, WORKFLOW_SOURCES, effectiveSettings, settingsImplications, workflowSettingsProblems } from '../workflow-settings';

/* eslint-disable @typescript-eslint/no-explicit-any */
const CONTRACTS = path.resolve(__dirname, '../../../../tests/contracts');
const load = (name: string): any => JSON.parse(readFileSync(path.join(CONTRACTS, name), 'utf8'));
/** JSON round-trip: what a fixture can hold (drops `undefined`, unfreezes). */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const BINDING_CASES: Array<[string, any]> = load('bindings.fixture.json').cases.map((entry: any) => [entry.name, entry]);

describe('node-io.fixture.json', () => {
  const fixture = load('node-io.fixture.json');

  it('pins the vocabulary and the 11 core node declarations', () => {
    expect(fixture.ioBaseTypes).toEqual(plain(IO_BASE_TYPES));
    expect(fixture.ioElementTypes).toEqual(plain(IO_ELEMENT_TYPES));
    expect(fixture.nodeIO).toEqual(plain(NODE_IO));
    expect(Object.keys(fixture.nodeIO)).toHaveLength(11);
  });

  it('pins agentNodeIO for every task (and the structured case)', () => {
    expect(fixture.agentNodeIO.map((entry: any) => entry.task).sort()).toEqual(
      ['NAMED_ENTITY_RECOGNITION', 'SPEECH_TO_TEXT', 'TEXT_GENERATION', 'TEXT_GENERATION', 'TEXT_TO_SPEECH'].sort(),
    );
    for (const entry of fixture.agentNodeIO) expect(plain(agentNodeIO(entry.task, entry.outputSchema)), entry.name).toEqual(entry.expected);
  });

  it('pins typeFits over the whole type matrix, and each verdict occurs', () => {
    expect(new Set(fixture.typeFits.map((entry: any) => entry.expected))).toEqual(new Set(['match', 'convert', 'blocked']));
    for (const entry of fixture.typeFits) expect(typeFits(entry.target, entry.source), `${entry.target} <- ${entry.source}`).toBe(entry.expected);
  });

  it('pins ioTypeOfJsonSchema', () => {
    for (const entry of fixture.ioTypeOfJsonSchema) expect(ioTypeOfJsonSchema(entry.schema), JSON.stringify(entry.schema)).toBe(entry.expected);
  });
});

describe('bindings.fixture.json', () => {
  const fixture = load('bindings.fixture.json');

  it('is not vacuous: legacy translation, fan-in, every issue code, and clean cases', () => {
    const names = fixture.cases.map((entry: any) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining(['legacy-seeded-consultation-shape', 'legacy-router-branches-carry-no-data', 'legacy-agent-in-port-by-task']),
    );
    const codes = new Set(fixture.cases.flatMap((entry: any) => entry.expected.issues.map((issue: any) => issue.code)));
    for (const code of [
      'BINDING_UNKNOWN_PATH',
      'BINDING_NOT_ANCESTOR',
      'BINDING_TYPE_MISMATCH',
      'BINDING_TYPE_CONVERTED',
      'BINDING_UNKNOWN_INPUT',
      'REQUIRED_INPUT_UNBOUND',
      'INPUT_MULTIPLE_PRODUCERS',
      'CONSULTATION_SCOPE_UNAVAILABLE',
    ]) {
      expect(codes.has(code), code).toBe(true);
    }
    expect(fixture.cases.some((entry: any) => entry.expected.issues.length === 0)).toBe(true);
    const seeded = fixture.cases.find((entry: any) => entry.name === 'legacy-seeded-consultation-shape');
    expect(seeded.expected.compiledBindings.n_ner).toEqual({
      text: { firstOf: ['nodes.n_transcript.outputs.text', 'nodes.n_asr.outputs.transcript'] },
    });
    expect(seeded.expected.compiledBindings.n_output).toEqual({ in: { from: 'nodes.n_finalize.outputs.data' } });
  });

  it.each(BINDING_CASES)('%s', (_name: string, entry: any) => {
    expect(plain(compiledBindings(entry.graph, entry.agents))).toEqual(entry.expected.compiledBindings);
    const issues = bindingIssues(entry.graph, { agents: entry.agents, contextPayloadSchema: entry.contextPayloadSchema, sources: entry.sources }).map(
      (issue) => ({
        nodeId: issue.nodeId,
        code: issue.code,
        severity: issue.severity,
        input: issue.input ?? null,
        path: issue.path,
      }),
    );
    expect(issues).toEqual(entry.expected.issues);
  });
});

describe('workflow-settings.fixture.json', () => {
  const fixture = load('workflow-settings.fixture.json');

  it('pins the vocabularies', () => {
    expect(fixture.connections).toEqual(plain(WORKFLOW_CONNECTIONS));
    expect(fixture.sources).toEqual(plain(WORKFLOW_SOURCES));
  });

  it('pins the shape validator by problem pointer', () => {
    expect(fixture.shape.some((entry: any) => entry.expectedPointers.length === 0)).toBe(true);
    expect(fixture.shape.some((entry: any) => entry.expectedPointers.length > 0)).toBe(true);
    for (const entry of fixture.shape) {
      expect(
        workflowSettingsProblems(entry.value).map((problem) => problem.slice(0, problem.indexOf(':'))),
        JSON.stringify(entry.value),
      ).toEqual(entry.expectedPointers);
    }
  });

  it('pins effectiveSettings, both origins', () => {
    expect(new Set(fixture.effective.map((entry: any) => entry.expected.origin))).toEqual(new Set(['settings', 'legacy']));
    for (const entry of fixture.effective) expect(plain(effectiveSettings(entry.graph)), entry.name).toEqual(entry.expected);
  });

  it('pins the four implications', () => {
    const ruleIds = new Set(fixture.implications.flatMap((entry: any) => entry.expected.map((found: any) => found.ruleId)));
    expect(ruleIds).toEqual(new Set(['WF-SET-001', 'WF-SET-002', 'WF-SET-003', 'WF-SET-004']));
    for (const entry of fixture.implications) {
      const found = settingsImplications(entry.graph, entry.settings, entry.context).map((implication) => ({
        ruleId: implication.ruleId,
        requires: implication.requires,
        nodeId: implication.nodeId,
      }));
      expect(found, entry.name).toEqual(entry.expected);
    }
  });
});

describe('consultation-read-schema.fixture.json', () => {
  const fixture = load('consultation-read-schema.fixture.json');

  it('pins the versioned schema, every path and the alias map', () => {
    expect(fixture.version).toBe(CONSULTATION_READ_SCHEMA_VERSION);
    expect(fixture.schema).toEqual(plain(CONSULTATION_READ_SCHEMA_V1));
    expect(fixture.paths).toEqual(plain(consultationReadPaths()));
    expect(fixture.aliases).toEqual(plain(PLATFORM_CONTEXT_ALIASES));
    expect(Object.keys(fixture.aliases)).toHaveLength(11);
  });

  it('pins declared-read extraction', () => {
    for (const entry of fixture.declaredReads) expect(plain(declaredConsultationReads(entry.graph)), entry.name).toEqual(entry.expected);
  });
});
