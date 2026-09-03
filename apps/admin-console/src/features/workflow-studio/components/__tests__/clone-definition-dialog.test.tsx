/**
 * `CloneDefinitionDialog` — the Studio's entry point for "make a new workflow from
 * this one", and for "start from a platform template".
 *
 * Presentational by design (the same shape as `PublishDialog`): the list screen owns the hooks
 * and passes state down, so these specs need no QueryClient and exercise the real component,
 * not a mock of it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloneDefinitionDialog } from '../clone-definition-dialog';
import type { WorkflowDefinition } from '../../api/types';

const definition = (overrides: Partial<WorkflowDefinition> = {}) =>
  ({
    id: 'def-1',
    tenantId: 'tenant-1',
    slug: 'discharge_summary',
    name: 'Discharge Summary',
    description: null,
    paletteKey: 'summarization',
    versionNumber: 1,
    parentVersionId: null,
    status: 'DRAFT',
    graph: { version: 1, nodes: [], edges: [] },
    graphChecksum: 'c1',
    compiledConfig: null,
    compiledConfigChecksum: null,
    registryChecksum: null,
    validationReport: null,
    currentRegistryChecksum: 'r1',
    needsReview: false,
    validatedAt: null,
    publishedAt: null,
    deprecatedAt: null,
    isActive: false,
    resourceStatus: 'ENABLED',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    version: 1,
    tags: [],
    ...overrides,
  }) as unknown as WorkflowDefinition;

afterEach(cleanup);

describe('CloneDefinitionDialog — cloning a known source', () => {
  it('pre-fills the slug and name from the source so the common path is one click', () => {
    render(<CloneDefinitionDialog open source={definition()} templates={[]} templatesLoading={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);

    expect((screen.getByLabelText(/New slug/i) as HTMLInputElement).value).toBe('discharge_summary_copy');
    expect((screen.getByLabelText(/^Name/i) as HTMLInputElement).value).toBe('Discharge Summary (copy)');
  });

  it('submits the source id with the entered slug and name', () => {
    const onConfirm = vi.fn();
    render(<CloneDefinitionDialog open source={definition()} templates={[]} templatesLoading={false} onOpenChange={vi.fn()} onConfirm={onConfirm} />);

    fireEvent.change(screen.getByLabelText(/New slug/i), { target: { value: 'discharge_summary_v2' } });
    fireEvent.change(screen.getByLabelText(/^Name/i), { target: { value: 'Discharge v2' } });
    fireEvent.click(screen.getByRole('button', { name: /^Clone$/ }));

    expect(onConfirm).toHaveBeenCalledWith({ sourceId: 'def-1', targetSlug: 'discharge_summary_v2', name: 'Discharge v2' });
  });

  it('refuses an invalid slug client-side, with a visible reason and no request', () => {
    const onConfirm = vi.fn();
    render(<CloneDefinitionDialog open source={definition()} templates={[]} templatesLoading={false} onOpenChange={vi.fn()} onConfirm={onConfirm} />);

    fireEvent.change(screen.getByLabelText(/New slug/i), { target: { value: 'Not A Slug' } });
    fireEvent.click(screen.getByRole('button', { name: /^Clone$/ }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/2-48 lowercase letters, digits or underscores/i)).toBeTruthy();
  });

  it('surfaces a server error instead of failing silently', () => {
    render(
      <CloneDefinitionDialog
        open
        source={definition()}
        templates={[]}
        templatesLoading={false}
        error="Slug 'discharge_summary' is already in use by this tenant."
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/already in use by this tenant/i)).toBeTruthy();
  });
});

describe('CloneDefinitionDialog — starting from a platform template', () => {
  const template = definition({
    id: 'sys-1',
    tenantId: '00000000-0000-0000-0000-000000000000',
    slug: 'platform_default_summarization',
    name: 'Platform Default — Summarization',
    status: 'PUBLISHED',
  });

  // `DialogContent` renders through a Radix PORTAL, so the dialog's DOM lives on
  // `document.body`, not under `render()`'s container. Querying the container would find
  // nothing and quietly assert against an empty tree — which is also why the axe scan below
  // targets `document.body`.
  it('shows skeletons — never a spinner — while the template library loads', () => {
    render(<CloneDefinitionDialog open source={null} templates={[]} templatesLoading onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(document.body.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('lists the templates and submits the selected one', () => {
    const onConfirm = vi.fn();
    render(
      <CloneDefinitionDialog open source={null} templates={[template]} templatesLoading={false} onOpenChange={vi.fn()} onConfirm={onConfirm} />,
    );

    fireEvent.click(screen.getByRole('radio', { name: /Platform Default/ }));
    fireEvent.change(screen.getByLabelText(/New slug/i), { target: { value: 'my_summary' } });
    fireEvent.click(screen.getByRole('button', { name: /^Clone$/ }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'sys-1', targetSlug: 'my_summary' }));
  });

  /**
   * the library now holds templates from DIFFERENT palettes: three
   * `consultation` example workflows and the `stt` transcription agent. Cloning an `stt`
   * definition when you wanted a consultation one produces a workflow that cannot govern a
   * consultation at all, so the palette has to be scannable, not buried in a mono line.
 */
  it('badges each template with its palette so an stt agent is not mistaken for a consultation workflow', () => {
    render(
      <CloneDefinitionDialog
        open
        source={null}
        templates={[
          definition({ id: 'tpl-ner', slug: 'consultation_ner', name: 'Consultation with Medical NER', paletteKey: 'consultation' }),
          definition({ id: 'tpl-stt', slug: 'transcription_agent', name: 'Realtime Transcription Agent', paletteKey: 'stt' }),
        ]}
        templatesLoading={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText('Consultation with Medical NER')).toBeTruthy();
    expect(screen.getByText('Realtime Transcription Agent')).toBeTruthy();
    expect(screen.getByText('consultation')).toBeTruthy();
    expect(screen.getByText('stt')).toBeTruthy();
    // The slug stays visible too — it is the lineage key the new slug is suggested from.
    expect(screen.getByText('consultation_ner')).toBeTruthy();
  });

  it('cannot submit before a template is picked', () => {
    const onConfirm = vi.fn();
    render(
      <CloneDefinitionDialog open source={null} templates={[template]} templatesLoading={false} onOpenChange={vi.fn()} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Clone$/ }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('explains an empty library rather than showing a blank area', () => {
    render(<CloneDefinitionDialog open source={null} templates={[]} templatesLoading={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText(/No platform templates/i)).toBeTruthy();
  });

  // Scoped to the dialog element rather than `document.body`: Radix renders its own
  // `data-radix-focus-guard` sentinels as SIBLINGS of the portal content, and those trip
  // `aria-hidden-focus` in every Radix overlay. Scanning the dialog itself keeps the assertion
  // pointed at this component's markup — and at real markup, unlike scanning `container`, which
  // for a portaled overlay is empty and would pass no matter what this component rendered.
  it('has no axe violations', async () => {
    render(<CloneDefinitionDialog open source={null} templates={[template]} templatesLoading={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(await axe(dialog as HTMLElement)).toHaveNoViolations();
  });
});
