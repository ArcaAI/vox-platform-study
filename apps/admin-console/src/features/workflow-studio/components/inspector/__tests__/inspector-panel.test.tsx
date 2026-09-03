/**
 * `InspectorPanel` — descriptors → the `Field` family, controlled state, no
 * `react-hook-form` ( Server `ValidationReport` problems for the selected node
 * render on the matching field via `FieldError`. When the node type carries no config schema
 * (the REAL registry today — `contracts/registry.contract.md`: no delivered node type has
 * one), the panel falls back to the raw `CodeEditor` over `node.config` directly.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { InspectorPanel } from '../inspector-panel';
import type { GraphStoreNode } from '../../../store/types';
import type { WorkflowFinding } from '../../../api/types';

const SCHEMA = {
  type: 'object',
  properties: {
    promptTemplateId: { type: 'string', title: 'Prompt Template Id', maxLength: 80 },
    retries: { type: 'integer', minimum: 0, maximum: 5, default: 1 },
    enabled: { type: 'boolean', default: true },
  },
  required: ['promptTemplateId'],
};

function node(config: Record<string, unknown> = {}): GraphStoreNode {
  return { id: 'n1', type: 'summarize', position: { x: 0, y: 0 }, safetyClasses: [], config };
}

function stubPromptTemplatesFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [{ id: 't-1', name: 'Discharge summary' }], count: 1 })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('InspectorPanel', () => {
  it('shows an empty state when no node is selected', () => {
    render(<InspectorPanel node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />);
    expect(screen.getByText(/select a node/i)).toBeTruthy();
  });

  it('renders a Skeleton matching the field layout while loading', () => {
    const { container } = render(<InspectorPanel node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={vi.fn()} loading />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders visible labels (never placeholder-only) for every schema field', () => {
    render(<InspectorPanel node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={vi.fn()} />);
    expect(screen.getByText(/^Prompt Template Id/)).toBeTruthy();
    expect(screen.getByText(/retries/i)).toBeTruthy();
    expect(screen.getByText(/enabled/i)).toBeTruthy();
  });

  it('marks the required field with *', () => {
    render(<InspectorPanel node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={vi.fn()} />);
    expect(screen.getByText(/^Prompt Template Id/).closest('[data-slot="field-label"]')?.textContent).toContain('*');
  });

  it('editing a string field calls onConfigChange with the merged config', () => {
    const onConfigChange = vi.fn();
    render(<InspectorPanel node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={onConfigChange} />);
    const input = screen.getByLabelText(/^Prompt Template Id/);
    fireEvent.change(input, { target: { value: 'discharge_v2' } });
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ promptTemplateId: 'discharge_v2' }));
  });

  it('renders a server problem for the matching field via FieldError, in text-destructive', () => {
    const problems: WorkflowFinding[] = [
      { ruleId: 'WF-C-004', ruleClass: 'schema', severity: 'ERROR', nodeId: 'n1', path: 'promptTemplateId', message: 'unknown template id' },
    ];
    render(<InspectorPanel node={node()} configSchema={SCHEMA} problems={problems} onConfigChange={vi.fn()} />);
    expect(screen.getByText('unknown template id')).toBeTruthy();
    expect(screen.getByRole('alert').className).toContain('text-destructive');
  });

  it('falls back to the raw CodeEditor when the node type has no config schema', () => {
    stubPromptTemplatesFetch();
    renderWithProviders(<InspectorPanel node={node({ raw: true })} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />);
    expect(screen.getByText(/no configuration schema/i)).toBeTruthy();
  });

  it('Task 19: also renders the PromptTemplatePicker below the raw JSON editor when there is no config schema', async () => {
    stubPromptTemplatesFetch();
    renderWithProviders(<InspectorPanel node={node({ raw: true })} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />);
    expect(await screen.findByText('Prompt template')).toBeTruthy();
    expect(screen.getByRole('link', { name: /manage prompt templates/i }).getAttribute('href')).toBe('/prompt-templates');
  });

  it('Task 19: selecting a prompt template merges promptTemplateId into node.config without disturbing other keys', async () => {
    stubPromptTemplatesFetch();
    const onConfigChange = vi.fn();
    renderWithProviders(<InspectorPanel node={node({ raw: true })} configSchema={undefined} problems={[]} onConfigChange={onConfigChange} />);
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

    const trigger = await screen.findByLabelText('Prompt template');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Discharge summary' })).toBeTruthy());
    // See prompt-template-picker.test.tsx for why `click`, not `pointerUp`, is the activation
    // path that works under jsdom's incomplete pointer-event pipeline.
    fireEvent.click(screen.getByRole('option', { name: 'Discharge summary' }));

    expect(onConfigChange).toHaveBeenCalledWith({ raw: true, promptTemplateId: 't-1' });
  });

  it('Task 19: the PromptTemplatePicker section steps aside when the schema already declares a promptTemplateId field', () => {
    render(<InspectorPanel node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={vi.fn()} />);
    // The schema's own generic string control ("Prompt Template Id") renders it — the Task 19
    // section (labeled exactly "Prompt template") never doubles up on the same key.
    expect(screen.getByText(/^Prompt Template Id/)).toBeTruthy();
    expect(screen.queryByText('Prompt template')).toBeNull();
  });

  it('0 axe violations with a schema-backed node selected', async () => {
    const { container } = render(<InspectorPanel node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
