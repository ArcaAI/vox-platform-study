/**
 * TASK-885 (owner #4) — the console half of workflow import/export.
 *
 * Two things are worth a test here and the rest is the server's job:
 *
 *   - `parseBundleJson` REFUSES the wrong file with a message that names what it actually is, so
 *     picking a graph export (or an agent export) costs a sentence rather than a confusing 400;
 *   - the dialog cannot submit without a parsed bundle, and it surfaces a server refusal
 *     VERBATIM — the gateway's 409 names the references this tenant is missing, and that naming
 *     is the whole value of the message.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportDefinitionDialog } from '../import-definition-dialog';
import { parseBundleJson, suggestImportSlug } from '../../lib/bundle-io';
import type { WorkflowDefinitionBundle } from '../../api/types';

const bundle: WorkflowDefinitionBundle = {
  kind: 'workflow-definition',
  schemaVersion: 1,
  exportedAt: '2026-09-06T00:00:00.000Z',
  source: { tenantKind: 'system', slug: 'discharge_summary', versionNumber: 3 },
  payload: {
    name: 'Discharge Summary',
    description: null,
    paletteKey: 'summarization',
    graph: { version: 1, nodes: [], edges: [] },
    references: [{ nodeId: 'n_gen', kind: 'promptTemplate', key: 'Discharge Summary Prompt' }],
  },
};

afterEach(cleanup);

describe('parseBundleJson', () => {
  it('accepts a workflow bundle', () => {
    const parsed = parseBundleJson(JSON.stringify(bundle));
    expect(parsed.ok).toBe(true);
  });

  it('names what the file actually is when it is the wrong kind', () => {
    const parsed = parseBundleJson(JSON.stringify({ ...bundle, kind: 'agent' }));
    expect(parsed).toEqual({ ok: false, reason: 'This is not a workflow export (kind: "agent").' });
  });

  it('refuses a bare GRAPH export — the other artifact the Studio can download', () => {
    const parsed = parseBundleJson(JSON.stringify({ version: 1, nodes: [], edges: [] }));
    expect(parsed.ok).toBe(false);
  });

  it('refuses an unsupported schema version and malformed JSON', () => {
    expect(parseBundleJson(JSON.stringify({ ...bundle, schemaVersion: 99 })).ok).toBe(false);
    expect(parseBundleJson('{oops').ok).toBe(false);
  });

  it('suggests a slug the tenant can accept or change', () => {
    expect(suggestImportSlug(bundle)).toBe('discharge_summary_imported');
  });
});

describe('ImportDefinitionDialog', () => {
  it('cannot submit until a bundle has been parsed', () => {
    const onConfirm = vi.fn();
    render(<ImportDefinitionDialog open onOpenChange={() => undefined} onConfirm={onConfirm} />);

    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('surfaces a server refusal verbatim — the 409 names the missing references', () => {
    render(
      <ImportDefinitionDialog
        open
        onOpenChange={() => undefined}
        onConfirm={() => undefined}
        error="Some target catalogue entries are missing: promptTemplate “Discharge Summary Prompt” on node n_gen."
      />,
    );

    expect(screen.getByText(/promptTemplate “Discharge Summary Prompt” on node n_gen/)).toBeTruthy();
  });

  it('has no axe violations', async () => {
    const { container } = render(<ImportDefinitionDialog open onOpenChange={() => undefined} onConfirm={() => undefined} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
