import { describe, expect, it } from 'vitest';
import { schemaVariablePaths } from '@arcaai/workflow-contract';
import { contextCompletionPaths, contextVariablePaths, declaredNamespaces, findingsAt, templateLint, variableNamePaths, withPlatformPaths } from '../template-lint';

const DEFINITION = {
  schemaVersion: 1,
  kinds: [
    {
      key: 'patient',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      required: true,
      fields: { type: 'object', properties: { age: { type: 'integer' }, name: { type: 'string' } }, required: ['age'] },
    },
    { key: 'transcript', primitive: 'TEXT', phiClass: 'PHI', required: true },
  ],
  outputs: [],
};

describe('template lint helpers', () => {
  it('offers only the canonical context root for completion, while the lint still admits the trigger alias', () => {
    const offered = contextCompletionPaths(DEFINITION).map((entry) => entry.path);
    expect(offered).toContain('context.patient.age');
    expect(offered.some((path) => path.startsWith('trigger.'))).toBe(false);
    const lint = templateLint(declaredNamespaces({ definition: DEFINITION, variables: [] }));
    expect(lint('{{trigger.patient.age}}')).toEqual([]);
  });

  it('offers context and trigger paths from one definition, plus bare variable names', () => {
    const paths = [...contextVariablePaths(DEFINITION), ...variableNamePaths(['topic'])];
    const names = paths.map((entry) => entry.path);
    expect(names).toContain('context.patient.age');
    expect(names).toContain('trigger.patient.age');
    expect(names).toContain('topic');
    expect(paths.find((entry) => entry.path === 'context.patient.age')?.phiClass).toBe('PHI');
  });

  it('squiggles an undeclared schema path at its placeholder, and only that one', () => {
    const declared = declaredNamespaces({ definition: DEFINITION, variables: ['topic'] });
    const content = 'Age {{context.patient.age}} and {{context.patient.nickname}} on {{topic}}';
    const diagnostics = templateLint(declared)(content);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.severity).toBe('error');
    expect(content.slice(diagnostics[0]?.from, diagnostics[0]?.to)).toBe('{{context.patient.nickname}}');
    expect(diagnostics[0]?.message).toMatch(/nickname/);
  });

  it('flags a context reference when no schema is bound, and a syntax error at its offset', () => {
    const lint = templateLint(declaredNamespaces({ definition: null, variables: [] }));
    expect(lint('{{context.x}}')[0]?.message).toMatch(/not a declared namespace/);
    const syntax = lint('Hello {{ unterminated');
    expect(syntax).toHaveLength(1);
    expect(syntax[0]?.from).toBe(6);
  });

  it('admits deeper paths under a field the schema does not describe further', () => {
    const lint = templateLint(declaredNamespaces({ definition: DEFINITION, variables: [] }));
    expect(lint('{{context.transcript.text}}')).toEqual([]);
  });

  it('matches the contract derivation it is built from', () => {
    expect(contextVariablePaths(DEFINITION).filter((entry) => entry.path.startsWith('context.'))).toEqual(schemaVariablePaths(DEFINITION, 'context'));
  });

  it('routes server findings to the field they concern', () => {
    const findings = [
      { severity: 'ERROR' as const, code: 'PROMPT_VARIABLE_UNDECLARED', path: 'instruction', message: 'a' },
      { severity: 'WARNING' as const, code: 'PROMPT_FRAGMENT_CONDITION_ROOT', path: 'instruction.fragments[1].when', message: 'b' },
      { severity: 'ERROR' as const, code: 'X', path: 'instruction.fragments[10].when', message: 'c' },
    ];
    expect(findingsAt(findings, 'instruction').map((finding) => finding.message)).toEqual(['a']);
    expect(findingsAt(findings, 'instruction.fragments[1].when').map((finding) => finding.message)).toEqual(['b']);
    expect(findingsAt(findings, 'instruction.fragments[1]', { prefix: true }).map((finding) => finding.message)).toEqual(['b']);
  });

  it('adds the platform vocabulary to the completion list, badged `platform`, never duplicating a schema path', () => {
    const single = {
      schemaVersion: 1,
      kinds: [
        { key: 'context', primitive: 'STRUCTURED', phiClass: 'PHI', fields: { type: 'object', properties: { safe_age: { type: 'integer' } } } },
      ],
    };
    const paths = withPlatformPaths(contextVariablePaths(single));
    const safeAge = paths.filter((entry) => entry.path === 'context.safe_age');
    expect(safeAge).toHaveLength(1);
    expect(safeAge[0]?.type).toBe('integer');
    expect(paths.find((entry) => entry.path === 'context.current_department')).toMatchObject({ source: 'platform', phiClass: 'NON_PHI' });
  });

  it('with `platform`, lint admits the platform names and still flags a made-up one', () => {
    const unbound = templateLint(declaredNamespaces({ definition: null, variables: [], platform: true }));
    expect(unbound('{{context.safe_age}} {{context.language_name}}')).toEqual([]);
    expect(unbound('{{context.foo}}')).toHaveLength(1);

    const bound = templateLint(declaredNamespaces({ definition: DEFINITION, variables: [], platform: true }));
    const content = '{{context.current_department}} {{context.patient.age}} {{context.patient.nickname}}';
    const diagnostics = bound(content);
    expect(diagnostics).toHaveLength(1);
    expect(content.slice(diagnostics[0]?.from, diagnostics[0]?.to)).toBe('{{context.patient.nickname}}');
  });
});
