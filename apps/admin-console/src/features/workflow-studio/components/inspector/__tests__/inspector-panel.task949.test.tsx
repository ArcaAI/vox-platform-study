/**
 * TASK-949 — the `core.agent` inspector, per referenced agent.
 *
 * D-8 here, and it turned out to be TWO defects stacked:
 *
 *  1. A server finding names its field with a JSON POINTER (`/overrides/generation/temperature`,
 *     `publish-findings.ts:446`) while a descriptor path is DOTTED
 *     (`overrides.generation.temperature`, `schema-form.ts`). `errorsForPath` compared them with
 *     `===`, so no pointer-shaped finding could ever match.
 *  2. Even a correctly-dotted nested path never arrived: only the TOP-LEVEL `descriptors.map` in
 *     `inspector-panel.tsx` resolved errors, and `FieldRenderer`'s `group` / `discriminated`
 *     branches recursed WITHOUT passing anything down. So `OVERRIDE_OUT_OF_RANGE` and
 *     `GUARDRAIL_OPTED_OUT` were invisible on their own fields regardless of convention.
 *
 * Both are asserted against the FIELD error slot specifically — the graph-level bucket is also
 * `role="alert"`, so a bare `getByRole('alert')` passes for the very bug this pins.
 */
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { InspectorPanel } from '../inspector-panel';
import type { GraphStoreNode } from '../../../store/types';
import type { WorkflowFinding } from '../../../api/types';

const NESTED_SCHEMA = {
  type: 'object',
  properties: {
    overrides: {
      type: 'object',
      properties: {
        generation: {
          type: 'object',
          properties: { temperature: { type: 'number', minimum: 0, maximum: 2 } },
        },
      },
    },
  },
};

function node(config: Record<string, unknown> = {}): GraphStoreNode {
  return { id: 'n1', type: 'summarize', position: { x: 0, y: 0 }, safetyClasses: [], config };
}

function finding(path: string, message: string): WorkflowFinding {
  return { ruleId: 'OVERRIDE_OUT_OF_RANGE', ruleClass: 'schema', severity: 'ERROR', nodeId: 'n1', path, message };
}

/** Text of every FIELD-level error slot — never the graph-level bucket, which carries no `data-slot`. */
function fieldErrors(container: HTMLElement): string {
  return [...container.querySelectorAll('[data-slot="field-error"]')].map((element) => element.textContent ?? '').join(' | ');
}

/** Text of the graph-level fallback list — `role="alert"` with no `data-slot`. */
function graphErrors(container: HTMLElement): string {
  return [...container.querySelectorAll('[role="alert"]:not([data-slot])')].map((element) => element.textContent ?? '').join(' | ');
}

function renderWith(problems: WorkflowFinding[], config: Record<string, unknown> = { overrides: { generation: { temperature: 5 } } }) {
  return renderWithProviders(
    <InspectorPanel tab="config" onTabChange={vi.fn()} node={node(config)} configSchema={NESTED_SCHEMA} problems={problems} onConfigChange={vi.fn()} />,
  );
}

describe('TASK-949 D-8 — findings reach the nested field they name', () => {
  it('renders a JSON-pointer finding on the nested field, not in the graph-level list', () => {
    const { container } = renderWith([finding('/overrides/generation/temperature', 'temperature 5 is outside 0..2')]);
    expect(fieldErrors(container)).toContain('temperature 5 is outside 0..2');
    expect(graphErrors(container)).not.toContain('temperature 5 is outside 0..2');
  });

  it('renders a dotted finding on the same nested field', () => {
    const { container } = renderWith([finding('overrides.generation.temperature', 'dotted still works')]);
    expect(fieldErrors(container)).toContain('dotted still works');
  });

  it('still renders a top-level finding on its field', () => {
    const { container } = renderWith([finding('overrides', 'the whole group is wrong')]);
    expect(fieldErrors(container)).toContain('the whole group is wrong');
  });

  it('leaves a genuinely unknown path in the graph-level list', () => {
    const { container } = renderWith([finding('/nowhere/at/all', 'not a field on this node')]);
    expect(graphErrors(container)).toContain('not a field on this node');
    expect(fieldErrors(container)).not.toContain('not a field on this node');
  });

  it('does not double-report: a matched finding appears exactly once', () => {
    renderWith([finding('/overrides/generation/temperature', 'reported once')]);
    expect(screen.getAllByText('reported once')).toHaveLength(1);
  });
});
