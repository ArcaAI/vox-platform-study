/**
 * TASK-939 §2.9 — the running-note template must not order a whole-note rewrite.
 *
 * ## What this pins, and why it is a seed test rather than a service test
 *
 * The owner's report is that every partial-summary turn tears down and re-renders the whole case
 * note instead of adding to it. One cause is literal: the seeded body bound to the running-note
 * agent instructed *"re-emit the whole note each time"*, while the runtime operating frame appended
 * to the SAME prompt (`LiveDocumentationService.operatingFrame`) says *"This is an UPDATE, not a
 * fresh note."* A model handed both follows the one that names an action.
 *
 * The contradiction lives in a seeded row, so the guard belongs here: a service test would pass
 * against a template that still says the opposite.
 *
 * These assertions are deliberately about the INSTRUCTION, not about phrasing — an author may
 * reword freely, but may not reinstate an order to reproduce the document wholesale.
 */
import { describe, expect, it } from 'vitest';

import { GENERAL_MEDICINE_SUMMARY_TEMPLATES } from '../07-prompt-template';
import { SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../00-constants';

/**
 * Phrasings that ORDER a full reproduction of the note. Each is an imperative about the whole
 * document, which is what makes it incompatible with an additive turn — unlike "the whole note is
 * shown to you above", which is a statement of fact and stays allowed.
 */
const ORDERS_A_FULL_REWRITE = [
  /re-?emit\s+the\s+whole/i,
  /re-?emit\s+the\s+(?:entire|complete|full)/i,
  /re-?(?:produce|generate|write)\s+the\s+(?:whole|entire|complete|full)\s+note/i,
  /output\s+the\s+(?:whole|entire|complete|full)\s+note\s+each/i,
];

/** The additive posture the turn actually has. */
const ADDITIVE_INSTRUCTION = /\badd\b|\bappend\b|\bextend\b/i;

describe('TASK-939 — the running-note template instructs accumulation, not re-emission', () => {
  const rows = [
    ['Global', GENERAL_MEDICINE_SUMMARY_TEMPLATES.find((row) => row.tenantId === SEED_TENANT_ID)!],
    ['SYSTEM', GENERAL_MEDICINE_SUMMARY_TEMPLATES.find((row) => row.tenantId === SYSTEM_TENANT_ID)!],
  ] as const;

  for (const [label, row] of rows) {
    it(`${label}: never orders a whole-note rewrite`, () => {
      for (const pattern of ORDERS_A_FULL_REWRITE) {
        expect(row.content, `${label} body matches ${pattern}`).not.toMatch(pattern);
      }
    });

    it(`${label}: states the additive posture explicitly`, () => {
      expect(row.content).toMatch(ADDITIVE_INSTRUCTION);
    });

    it(`${label}: still forbids treating the encounter as finished`, () => {
      // Guards against "fixing" the rewrite order by deleting the whole paragraph: the
      // in-progress posture in the same sentence is load-bearing and must survive.
      expect(row.content).toMatch(/never treat the conversation as finished/i);
      expect(row.content).toMatch(/no closing summary/i);
    });
  }

  it('both tenants carry byte-identical bodies (SYSTEM is the promoted copy)', () => {
    expect(rows[1][1].content).toBe(rows[0][1].content);
  });
});
