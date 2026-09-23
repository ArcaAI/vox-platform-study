/**
 * TASK-1001 — owner directive 2026-09-23: "for now, all pre-summary and summary must be in english,
 * therefore, prompt instructions and configuration must be set to english".
 *
 * The runtime already forces English (the policy fragment, the named-override step). This file pins
 * that the seeded INSTRUCTIONS say so too: the three system rows that used to name "the
 * conversation language" now name English, whatever language was spoken.
 *
 * `CORRECTIVE_RETRY_INSTRUCTION` (`@arcaai/applications` `bounded-json-repair.ts`) is documented as
 * a byte-for-byte mirror of the seeded Corrective Retry row, and both halves changed here, so their
 * parity is pinned too. The applications source is read as TEXT: this package does not depend on
 * `@arcaai/applications`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_PROMPT_TEMPLATES, TEMPLATE_IDS } from '../07-prompt-template';

const contentOf = (id: string): string => String(DEFAULT_PROMPT_TEMPLATES.find((template) => template.id === id)!.content);

const CONVERSATION_LANGUAGE_CLAUSES = [/conversation language/i, /target language/i, /English words/, /equivalents? in/];

describe('TASK-1001 — the seeded system instructions name English', () => {
  const rows = {
    'SMR System Prompt - Base': contentOf(TEMPLATE_IDS.TEXT_SYSTEM_BASE),
    'JSON Enforcement Note': contentOf(TEMPLATE_IDS.JSON_ENFORCEMENT),
    'Corrective Retry Suffix': contentOf(TEMPLATE_IDS.CORRECTIVE_RETRY),
  };

  it.each(Object.entries(rows))('%s carries no conversation-language clause', (_name, content) => {
    for (const clause of CONVERSATION_LANGUAGE_CLAUSES) expect(content).not.toMatch(clause);
  });

  it('each row states English, whatever language was spoken', () => {
    expect(rows['SMR System Prompt - Base']).toContain('- CRITICAL: Always respond in English, whatever language the conversation was in');
    expect(rows['SMR System Prompt - Base']).toContain('- Use standard English medical terminology');
    expect(rows['JSON Enforcement Note']).toContain('MUST be in English, whatever language was spoken, and formatted using markdown.');
    expect(rows['JSON Enforcement Note']).toContain('write a succinct statement in English');
    expect(rows['Corrective Retry Suffix']).toContain(
      'All headings/labels and descriptive content inside values MUST be in English, whatever language was spoken.',
    );
  });

  it('the Corrective Retry row and the runtime CORRECTIVE_RETRY_INSTRUCTION are byte-identical', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      path.resolve(HERE, '../../../../../../applications/src/services/consultation/shared/bounded-json-repair.ts'),
      'utf8',
    );
    const literal = /export const CORRECTIVE_RETRY_INSTRUCTION = `([^`]*)`;/.exec(source);
    expect(literal, 'CORRECTIVE_RETRY_INSTRUCTION literal not found').not.toBeNull();
    // The literal carries no interpolation and no escape other than `\n`.
    const runtime = literal![1]!.replace(/\\n/g, '\n');
    expect(runtime).toBe(rows['Corrective Retry Suffix']);
  });
});
