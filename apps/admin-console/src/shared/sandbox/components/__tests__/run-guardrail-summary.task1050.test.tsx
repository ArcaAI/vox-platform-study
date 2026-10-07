/**
 * TASK-1050 W3b — the run trace renders the guardrail additions from the protocol-v2 fold: the paused
 * state with its notice, the notices, WARN / IGNORE screens with per-check verdicts and action taken,
 * and a warn badge on the node.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import { foldRunEvents } from '../../api/run-fold';
import { parseRunEventFrame, type RunEvent } from '../../api/run-protocol';
import { NodeGuardrailBadge, RunGuardrailSummary } from '../run-guardrail-summary';

afterEach(() => cleanup());

const OVERLAY = JSON.parse(
  // happy-dom replaces the global `URL`, so resolve the path with node:path instead of `new URL(…, import.meta.url)`.
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../../../tests/contracts/guardrail-run-events.fixture.json'), 'utf8'),
) as { examples: Array<{ name: string; event: unknown }> };

function example(name: string): RunEvent {
  const parsed = parseRunEventFrame(JSON.stringify(OVERLAY.examples.find((entry) => entry.name === name)?.event));
  if (!parsed) throw new Error(name);
  return parsed;
}

const started: RunEvent = { seq: 1, runId: 'run_01J9ZQ4V8W3K2N5P7R9T1X3Z5B', type: 'run.started', ts: '2026-10-07T09:14:00.000Z', data: { kind: 'workflow', slug: 'w', versionNumber: 1 } };
const nodeStarted: RunEvent = { seq: 2, runId: started.runId, type: 'node.started', ts: started.ts, nodeId: 'n_note', data: { kind: 'core.agent', label: 'Note' } };

describe('RunGuardrailSummary', () => {
  it('renders the paused state with its notice copy', () => {
    const view = foldRunEvents([started, nodeStarted, example('guardrail.notice (blocked, resumable)'), example('run.paused (guardrail hold)')]);
    render(<RunGuardrailSummary view={view} />);
    const paused = screen.getByRole('status');
    expect(within(paused).getByText(/paused at note on a guardrail hold/i)).toBeDefined();
    expect(within(paused).getByText(GUARDRAIL_NOTICE_DEFAULT_MESSAGES['guardrail.blocked.outbound'])).toBeDefined();
  });

  it('renders WARN and IGNORE screens with each check verdict and action taken', () => {
    const view = foldRunEvents([started, nodeStarted, example('guardrail.inbound (WARN with checks)'), example('guardrail.outbound (IGNORE with checks)')]);
    render(<RunGuardrailSummary view={view} />);
    expect(screen.getAllByText('Warned').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Recorded').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Flagged').length).toBeGreaterThan(0);
    expect(screen.getByText('Guardrail warning')).toBeDefined();
  });

  it('lists the notices of a run and says so when there is no activity', () => {
    const view = foldRunEvents([started, nodeStarted, example('guardrail.notice (warning, public)')]);
    const { unmount } = render(<RunGuardrailSummary view={view} />);
    expect(screen.getByRole('region', { name: /guardrail notices \(1\)/i })).toBeDefined();
    unmount();
    render(<RunGuardrailSummary view={foldRunEvents([started, nodeStarted])} />);
    expect(screen.getByText(/no guardrail activity/i)).toBeDefined();
  });

  it('badges a node paused on a hold, and renders nothing for a clean node', () => {
    const paused = foldRunEvents([started, nodeStarted, example('run.paused (guardrail hold)')]);
    const { unmount } = render(<NodeGuardrailBadge node={paused.nodes.n_note} />);
    expect(screen.getByText('Paused on guardrail')).toBeDefined();
    unmount();
    const { container } = render(<NodeGuardrailBadge node={foldRunEvents([started, nodeStarted]).nodes.n_note} />);
    expect(container.textContent).toBe('');
  });
});
