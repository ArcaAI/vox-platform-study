/**
 * TASK-890 §3.2 — the ONE template grammar, in TypeScript.
 *
 * Six templating flavours rendered the same prompts before this ticket (§2.4): two
 * single-brace regexes, three flat-key `{{ }}` copies and one dotted-path Python resolver. This
 * file pins the single grammar that replaces all six. The Python mirror
 * (`apps/harness/src/harness/temporal/interpreter/templating.py`) is held to the SAME committed
 * fixture (`tests/contracts/prompt-template.fixture.json`) by two loaders, so a capability added
 * to one renderer without a fixture case is drift neither suite can see.
 *
 * The rules under test are the §3.2 semantics table, verbatim: one pass (a substituted value is
 * never re-interpreted), own-property dotted traversal over PLAIN OBJECTS only, `null` is
 * missing, `default("…")` is the only filter, `{{{{` escapes, and a SINGLE brace is literal —
 * the deleted grammar is not silently honoured.
 */
import { describe, expect, it } from 'vitest';
import {
  PromptTemplateSyntaxError,
  PromptVariableUnresolvedError,
  renderTemplate,
  templateReferenceProblems,
  templateReferences,
  templateSyntaxProblems,
} from '../template';

describe('renderTemplate — resolution', () => {
  it('resolves a dotted path by traversal', () => {
    expect(renderTemplate('Age: {{trigger.patient.age}}', { trigger: { patient: { age: 67 } } })).toBe('Age: 67');
  });

  it('resolves a bare name from the scope root', () => {
    expect(renderTemplate('Dept: {{department}}', { department: 'cardiology' })).toBe('Dept: cardiology');
  });

  it('tolerates whitespace inside the placeholder', () => {
    const scope = { a: { b: 'x' } };
    expect(renderTemplate('{{ a.b }}', scope)).toBe(renderTemplate('{{a.b}}', scope));
    expect(renderTemplate('{{\ta.b\t}}', scope)).toBe('x');
  });

  it('throws PromptVariableUnresolved on a path that does not resolve', () => {
    expect(() => renderTemplate('{{context.absent}}', { context: {} })).toThrow(PromptVariableUnresolvedError);
    try {
      renderTemplate('{{context.absent}}', { context: {} }, { templateRef: 'tpl-1' });
    } catch (error) {
      expect(error).toBeInstanceOf(PromptVariableUnresolvedError);
      expect((error as PromptVariableUnresolvedError).path).toBe('context.absent');
      expect((error as PromptVariableUnresolvedError).templateRef).toBe('tpl-1');
    }
  });

  it('treats a `null` leaf as missing', () => {
    expect(() => renderTemplate('{{vars.notes}}', { vars: { notes: null } })).toThrow(PromptVariableUnresolvedError);
    expect(renderTemplate('{{vars.notes | default("none")}}', { vars: { notes: null } })).toBe('none');
  });

  it('never traverses INTO an array — an array is a value, not a namespace', () => {
    // An INDEX is not even a valid identifier, so the grammar refuses it outright…
    expect(() => renderTemplate('{{vars.list.0}}', { vars: { list: [1, 2] } })).toThrow(PromptTemplateSyntaxError);
    // …and a well-formed path through an array still does not resolve.
    expect(() => renderTemplate('{{vars.list.length}}', { vars: { list: [1, 2] } })).toThrow(PromptVariableUnresolvedError);
    expect(renderTemplate('{{vars.list}}', { vars: { list: [1, 2] } })).toBe('[1,2]');
  });

  it('does not treat a prototype key as a variable (own-property lookup)', () => {
    expect(() => renderTemplate('{{constructor}}', {})).toThrow(PromptVariableUnresolvedError);
    expect(() => renderTemplate('{{a.toString}}', { a: {} })).toThrow(PromptVariableUnresolvedError);
  });

  it('JSON-serialises a non-string value with SORTED keys and no spaces', () => {
    expect(renderTemplate('{{vars.obj}}', { vars: { obj: { b: [1, 2], a: 1 } } })).toBe('{"a":1,"b":[1,2]}');
    expect(renderTemplate('{{vars.n}}', { vars: { n: 3 } })).toBe('3');
    expect(renderTemplate('{{vars.t}}', { vars: { t: true } })).toBe('true');
  });
});

describe('renderTemplate — the default filter', () => {
  it('applies `default("…")` when the path misses', () => {
    expect(renderTemplate('{{context.absent | default("n/a")}}', { context: {} })).toBe('n/a');
  });

  it('does NOT apply the default when the value is present', () => {
    expect(renderTemplate('{{context.x | default("n/a")}}', { context: { x: 'here' } })).toBe('here');
  });

  it('unescapes a backslash escape inside the default string', () => {
    expect(renderTemplate('{{absent | default("say \\"hi\\"")}}', {})).toBe('say "hi"');
  });
});

describe('renderTemplate — literals, escapes and the ONE pass', () => {
  it('renders `{{{{` as the literal `{{`', () => {
    expect(renderTemplate('{{{{a}}', {})).toBe('{{a}}');
  });

  it('leaves a SINGLE brace verbatim — the deleted grammar is not honoured', () => {
    expect(renderTemplate('Hello {language_name}, {{name}}', { name: 'Ada' })).toBe('Hello {language_name}, Ada');
  });

  it('never re-interprets a substituted value (exactly one pass)', () => {
    expect(renderTemplate('{{a}}', { a: '{{b}}', b: 'NEVER' })).toBe('{{b}}');
  });
});

describe('templateSyntaxProblems', () => {
  it('is empty for a well-formed template', () => {
    expect(templateSyntaxProblems('a {{b.c}} d {{e | default("f")}} {{{{g}}')).toEqual([]);
  });

  it('refuses an unknown filter', () => {
    const problems = templateSyntaxProblems('{{a | upper}}');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('default');
  });

  it('refuses an unterminated placeholder', () => {
    expect(templateSyntaxProblems('{{a')).toHaveLength(1);
  });

  it('refuses an invalid identifier', () => {
    expect(templateSyntaxProblems('{{9lives}}')).toHaveLength(1);
    expect(templateSyntaxProblems('{{a..b}}')).toHaveLength(1);
  });

  it('reports EVERY malformed placeholder, not just the first', () => {
    expect(templateSyntaxProblems('{{a | upper}} and {{9lives}}')).toHaveLength(2);
  });

  it('is what renderTemplate throws on', () => {
    expect(() => renderTemplate('{{a | upper}}', { a: 'x' })).toThrow(PromptTemplateSyntaxError);
  });
});

describe('templateReferences', () => {
  it('reports the path, the default flag and the source offset of every placeholder', () => {
    expect(templateReferences('x {{a.b}} y {{c | default("z")}}')).toEqual([
      { path: 'a.b', hasDefault: false, offset: 2 },
      { path: 'c', hasDefault: true, offset: 12 },
    ]);
  });

  it('skips escapes and malformed placeholders', () => {
    expect(templateReferences('{{{{a}} {{b}}')).toEqual([{ path: 'b', hasDefault: false, offset: 8 }]);
  });
});

describe('templateReferenceProblems', () => {
  const declared = {
    roots: {
      context: { type: 'object', additionalProperties: false, properties: { patientAge: { type: 'number' } } },
      trigger: { type: 'object', additionalProperties: false, properties: { patientAge: { type: 'number' } } },
      // an inline schema that declares nothing about its shape — a WILDCARD root
      input: { type: 'object', additionalProperties: true },
      nodes: null,
    },
    variables: ['age'],
  };

  it('accepts a declared field under a declared root', () => {
    expect(templateReferenceProblems('{{context.patientAge}}', declared)).toEqual([]);
  });

  it('accepts ANY sub-path under an unknown-shaped root', () => {
    expect(templateReferenceProblems('{{input.whatever.deep}} {{nodes.n1.text}}', declared)).toEqual([]);
  });

  it('refuses an undeclared field under a closed root', () => {
    expect(templateReferenceProblems('{{context.absent}}', declared)).toHaveLength(1);
  });

  it('refuses an undeclared ROOT', () => {
    expect(templateReferenceProblems('{{banana.x}}', declared)).toHaveLength(1);
  });

  it('accepts a declared bare variable and refuses an undeclared one', () => {
    expect(templateReferenceProblems('{{age}}', declared)).toEqual([]);
    expect(templateReferenceProblems('{{height}}', declared)).toHaveLength(1);
  });

  it('never reports a reference that carries `default(...)` — a defaulted miss is not a problem', () => {
    expect(templateReferenceProblems('{{context.absent | default("n/a")}} {{banana.x | default("q")}}', declared)).toEqual([]);
  });

  /**
   * J3-6 — ONE problem per undeclared NAME, not one per occurrence.
   *
   * A prompt that repeats `{{context.safe_age}}` in its header and again in its body is one
   * authoring mistake, and the author fixes it once. Reporting it twice inflates the report
   * (measured on dev: 17 findings for 9 distinct placeholders) and buries the names that appear
   * only once — the report reads as a wall rather than a list of things to do.
   *
   * `templateReferences` still reports every OCCURRENCE with its offset: that is a fact about
   * the source and something an editor highlights. Deduplication belongs to the FINDING.
   */
  it('reports an undeclared name ONCE however many times the template repeats it', () => {
    const problems = templateReferenceProblems('{{context.absent}} and again {{context.absent}}', declared);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('context.absent');
  });

  it('still reports each DISTINCT undeclared name', () => {
    expect(templateReferenceProblems('{{context.absent}} {{context.other}} {{context.absent}}', declared)).toHaveLength(2);
  });

  it('does not collapse a bare name onto a same-named path (they are different references)', () => {
    expect(templateReferenceProblems('{{height}} {{height.cm}}', declared)).toHaveLength(2);
  });

  it('declares nothing ⇒ every non-defaulted reference is undeclared (the check has no "unknown" mode)', () => {
    expect(templateReferenceProblems('{{context.absent}} {{age}}', {})).toHaveLength(2);
    expect(templateReferenceProblems('{{context.absent | default("x")}}', {})).toEqual([]);
  });
});
