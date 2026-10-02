/**
 * `PLATFORM_CONTEXT_VARIABLES` — the flat `context.*` vocabulary the GATEWAY derives and binds
 * for a prompt (`PromptAssemblyService`, the live lanes), declared once so publish admits it and
 * the console suggests it. No context-schema kind declares these names.
 */
import { describe, expect, it } from 'vitest';
import { PLATFORM_CONTEXT_VARIABLES, templateReferenceProblems, withPlatformContextVariables } from '../index';

const SEEDED_NAMES = [
  'current_department',
  'dna_redaction_rules_text',
  'dna_style_text',
  'formatted_previous_visits',
  'formatted_test_results',
  'language_name',
  'safe_age',
  'safe_dob',
  'safe_gender',
  'safe_vitals',
  'visit_type',
];

describe('PLATFORM_CONTEXT_VARIABLES', () => {
  it('declares exactly the gateway-supplied flat vocabulary, sorted by path', () => {
    const paths = PLATFORM_CONTEXT_VARIABLES.map((entry) => entry.path);
    expect(paths).toEqual(SEEDED_NAMES.map((name) => `context.${name}`));
  });

  it('every entry is optional, platform-sourced, not deprecated, typed and described', () => {
    for (const entry of PLATFORM_CONTEXT_VARIABLES) {
      expect(entry).toMatchObject({ required: false, deprecated: false, source: 'platform', type: 'string' });
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.phiClass === null || entry.phiClass === 'PHI' || entry.phiClass === 'NON_PHI').toBe(true);
    }
  });

  it('classes patient-bearing values PHI and the encounter labels NON_PHI', () => {
    const phi = Object.fromEntries(PLATFORM_CONTEXT_VARIABLES.map((entry) => [entry.path.slice('context.'.length), entry.phiClass]));
    for (const name of ['safe_age', 'safe_dob', 'safe_gender', 'safe_vitals', 'formatted_test_results', 'formatted_previous_visits']) {
      expect(phi[name]).toBe('PHI');
    }
    for (const name of ['current_department', 'language_name', 'visit_type']) {
      expect(phi[name]).toBe('NON_PHI');
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PLATFORM_CONTEXT_VARIABLES)).toBe(true);
  });
});

describe('withPlatformContextVariables', () => {
  const body = 'Dept {{context.current_department}}; age {{context.safe_age}}; {{context.foo}}.';

  it('declares a `context` root when none was bound — the platform names pass, a made-up one does not', () => {
    const problems = templateReferenceProblems(body, withPlatformContextVariables({ roots: { input: null } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('context.foo');
  });

  it('widens a CLOSED context schema without letting it admit anything else', () => {
    const closed = { type: 'object', additionalProperties: false, properties: { kind_a: { type: 'object' } } };
    const declared = withPlatformContextVariables({ roots: { context: closed } });
    const problems = templateReferenceProblems(`${body} {{context.kind_a}}`, declared);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('context.foo');
    // the input is not mutated
    expect(Object.keys(closed.properties)).toEqual(['kind_a']);
  });

  it("never overrides the schema's own declaration of a name", () => {
    const own = {
      type: 'object',
      additionalProperties: false,
      properties: { safe_age: { type: 'object', additionalProperties: false, properties: {} } },
    };
    const declared = withPlatformContextVariables({ roots: { context: own } });
    expect(templateReferenceProblems('{{context.safe_age.years}}', declared)).toHaveLength(1);
  });

  it('leaves an unknown-shaped context root alone (it already admits everything)', () => {
    const declared = withPlatformContextVariables({ roots: { context: null } });
    expect(declared.roots?.context).toBeNull();
  });

  it('touches no root but `context`', () => {
    const declared = withPlatformContextVariables({
      roots: { trigger: { type: 'object', additionalProperties: false, properties: {} } },
      variables: ['x'],
    });
    expect(templateReferenceProblems('{{trigger.safe_age}}', declared)).toHaveLength(1);
    expect(declared.variables).toEqual(['x']);
  });
});
