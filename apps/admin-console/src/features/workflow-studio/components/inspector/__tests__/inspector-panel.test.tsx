/**
 * `InspectorPanel` — descriptors → the `Field` family, controlled state, no
 * `react-hook-form` ( Server `ValidationReport` problems for the selected node
 * render on the matching field via `FieldError`. When the node type carries no config schema
 * (the REAL registry today — `contracts/registry.contract.md`: no delivered node type has
 * one), the panel falls back to the raw `CodeEditor` over `node.config` directly.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_CONFIG_SCHEMAS } from '@arcaai/workflow-contract';
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
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />);
    expect(screen.getByText(/select a node/i)).toBeTruthy();
  });

  it('renders a Skeleton matching the field layout while loading', () => {
    const { container } = renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={vi.fn()} loading />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders visible labels (never placeholder-only) for every schema field', () => {
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={vi.fn()} />);
    expect(screen.getByText(/^Prompt Template Id/)).toBeTruthy();
    expect(screen.getByText(/retries/i)).toBeTruthy();
    expect(screen.getByText(/enabled/i)).toBeTruthy();
  });

  it('marks the required field with *', () => {
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={vi.fn()} />);
    expect(screen.getByText(/^Prompt Template Id/).closest('[data-slot="field-label"]')?.textContent).toContain('*');
  });

  it('editing a string field calls onConfigChange with the merged config', () => {
    const onConfigChange = vi.fn();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={onConfigChange} />);
    const input = screen.getByLabelText(/^Prompt Template Id/);
    fireEvent.change(input, { target: { value: 'discharge_v2' } });
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ promptTemplateId: 'discharge_v2' }));
  });

  it('renders a server problem for the matching field via FieldError, in text-destructive', () => {
    const problems: WorkflowFinding[] = [
      { ruleId: 'WF-C-004', ruleClass: 'schema', severity: 'ERROR', nodeId: 'n1', path: 'promptTemplateId', message: 'unknown template id' },
    ];
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node()} configSchema={SCHEMA} problems={problems} onConfigChange={vi.fn()} />);
    expect(screen.getByText('unknown template id')).toBeTruthy();
    expect(screen.getByRole('alert').className).toContain('text-destructive');
  });

  it('falls back to the raw CodeEditor when the node type has no config schema', () => {
    stubPromptTemplatesFetch();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node({ raw: true })} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />);
    expect(screen.getByText(/no configuration schema/i)).toBeTruthy();
  });

  it('Task 19: also renders the PromptTemplatePicker below the raw JSON editor when there is no config schema', async () => {
    stubPromptTemplatesFetch();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node({ raw: true })} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />);
    expect(await screen.findByText('Prompt template')).toBeTruthy();
  });

  it('TASK-890: the deep link targets /prompt-templates?template=<id> once a template is bound (the shared picker`s quick view)', async () => {
    stubPromptTemplatesFetch();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node({ raw: true, promptTemplateId: 't-1' })} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />);
    const link = (await screen.findByRole('link', { name: /open in prompt templates/i })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/prompt-templates?template=t-1');
  });

  it('Task 19: selecting a prompt template merges promptTemplateId into node.config without disturbing other keys', async () => {
    stubPromptTemplatesFetch();
    const onConfigChange = vi.fn();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node({ raw: true })} configSchema={undefined} problems={[]} onConfigChange={onConfigChange} />);
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
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={vi.fn()} />);
    // The schema's own generic string control ("Prompt Template Id") renders it — the Task 19
    // section (labeled exactly "Prompt template") never doubles up on the same key.
    expect(screen.getByText(/^Prompt Template Id/)).toBeTruthy();
    expect(screen.queryByText('Prompt template')).toBeNull();
  });

  it('0 axe violations with a schema-backed node selected', async () => {
    const { container } = renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={node()} configSchema={SCHEMA} problems={[]} onConfigChange={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * TASK-890 §3.10 integration coverage — the withholding + `fieldOverrides` wiring, against the
 * REAL delivered `core.trigger` / `core.agent` schemas (`@arcaai/workflow-contract`), not a
 * hand-rolled fixture: the generic renderer's raw `contextSchemaId` box and raw-json
 * `overrides.promptVariables` box are gone, replaced by the specialized fields, and every other
 * generic field on the same schema (`kinds`, `overrides.generation`) still renders untouched.
 */
describe('InspectorPanel — TASK-890 core.trigger', () => {
  function triggerNode(config: Record<string, unknown> = { kinds: ['api'] }): GraphStoreNode {
    return { id: 'trigger-1', type: 'core.trigger', position: { x: 0, y: 0 }, safetyClasses: [], config };
  }

  function stubContextSchemasFetch(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([{ id: 's-1', slug: 'intake', name: 'Intake', status: 'PUBLISHED', pinnedVersionNumber: 1, isDefault: true }]),
      ),
    );
  }

  it('renders ContextSchemaRefField instead of the raw contextSchemaId / inline boxes', async () => {
    stubContextSchemasFetch();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={triggerNode()} configSchema={NODE_CONFIG_SCHEMAS['core.trigger']} problems={[]} onConfigChange={vi.fn()} />);
    expect(await screen.findByText('Context schema')).toBeTruthy();
    expect(screen.queryByLabelText(/context schema id/i)).toBeNull();
  });

  it('renders the workflow-scope GuardrailField, labelled "Workflow default"', async () => {
    stubContextSchemasFetch();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={triggerNode()} configSchema={NODE_CONFIG_SCHEMAS['core.trigger']} problems={[]} onConfigChange={vi.fn()} />);
    expect(await screen.findByLabelText('Workflow default')).toBeTruthy();
  });

  it('still renders the schema`s other generic fields (kinds) untouched', async () => {
    stubContextSchemasFetch();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={triggerNode()} configSchema={NODE_CONFIG_SCHEMAS['core.trigger']} problems={[]} onConfigChange={vi.fn()} />);
    expect(await screen.findByLabelText(/^Kinds/)).toBeTruthy();
  });
});

describe('InspectorPanel — TASK-890 core.agent', () => {
  function agentNode(config: Record<string, unknown> = { agentRef: { slug: 'discharge' } }): GraphStoreNode {
    return { id: 'agent-1', type: 'core.agent', position: { x: 0, y: 0 }, safetyClasses: [], config };
  }

  function stubAgentsFetch(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          {
            slug: 'discharge',
            name: 'Discharge summary',
            task: 'TEXT_GENERATION',
            instruction: { variables: { topic: { value: '' } } },
            parameters: { guards: { enabled: false } },
          },
        ]),
      ),
    );
  }

  it('renders the node-scope GuardrailField, labelled "This node", reflecting the agent`s own default', async () => {
    stubAgentsFetch();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={agentNode()} configSchema={NODE_CONFIG_SCHEMAS['core.agent']} problems={[]} onConfigChange={vi.fn()} />);
    expect(await screen.findByLabelText('This node')).toBeTruthy();
    expect(await screen.findByText(/effective: off — agent/i)).toBeTruthy();
  });

  it('renders PromptVariablesField with one row per the agent`s declared variable, instead of a raw-json box', async () => {
    stubAgentsFetch();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={agentNode()} configSchema={NODE_CONFIG_SCHEMAS['core.agent']} problems={[]} onConfigChange={vi.fn()} />);
    expect(await screen.findByLabelText('topic')).toBeTruthy();
  });

  it('still renders the schema`s other generic overrides fields (generation) untouched', async () => {
    stubAgentsFetch();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={agentNode()} configSchema={NODE_CONFIG_SCHEMAS['core.agent']} problems={[]} onConfigChange={vi.fn()} />);
    expect(await screen.findByText('Generation')).toBeTruthy();
  });

  /**
   * TASK-890 black-box J4-F6 — the seeded platform agents carry an EMPTY `instruction.variables`
   * while their bound prompt template declares several, so the field rendered zero rows for an
   * agent whose prompt plainly has variables. The template's own declaration is the fallback,
   * read through the SAME shared picker projection the agents form uses (no new route).
   */
  it('falls back to the bound prompt template`s declared variables when the agent declares none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('admin/agents')) {
          return Response.json([
            { slug: 'discharge', name: 'Discharge summary', task: 'TEXT_GENERATION', instruction: { promptTemplateId: 'tpl-1', variables: {} } },
          ]);
        }
        if (url.includes('admin/prompt-templates/tpl-1')) {
          return Response.json({
            id: 'tpl-1',
            name: 'Discharge summary',
            status: 'APPROVED',
            category: 'SUMMARY',
            currentVersionNumber: 2,
            declaredVariables: [{ name: 'chief_complaint', type: 'string', required: true }],
          });
        }
        return Response.json([]);
      }),
    );

    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={agentNode()} configSchema={NODE_CONFIG_SCHEMAS['core.agent']} problems={[]} onConfigChange={vi.fn()} />);

    expect(await screen.findByLabelText('chief_complaint')).toBeTruthy();
    expect(await screen.findByText(/from the bound prompt template/i)).toBeTruthy();
  });

  /**
   * TASK-890 black-box J4-F5 — the chips are the workflow's REAL trigger paths when its trigger
   * binds a context schema; the version rows already carry the definition, so this reuses the
   * read the reference picker performs rather than adding a route.
   */
  it('offers the bound context schema`s kind paths as prompt-variable chips', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('admin/agents')) {
          return Response.json([
            { slug: 'discharge', name: 'Discharge summary', task: 'TEXT_GENERATION', instruction: { variables: { topic: { value: '' } } } },
          ]);
        }
        if (url.includes('/versions')) {
          return Response.json([
            { versionNumber: 2, definition: { schemaVersion: '1.0', kinds: [{ key: 'consultation_note', label: 'Note', primitive: 'TEXT' }] } },
          ]);
        }
        return Response.json([]);
      }),
    );

    renderWithProviders(
      <InspectorPanel tab="config" onTabChange={vi.fn()}
        node={agentNode()}
        configSchema={NODE_CONFIG_SCHEMAS['core.agent']}
        problems={[]}
        onConfigChange={vi.fn()}
        triggerContextBinding={{ schemaId: 's-1', versionNumber: null, inline: null }}
      />,
    );

    expect(await screen.findByRole('button', { name: 'trigger.consultation_note' })).toBeTruthy();
  });
});

/**
 * TASK-893 B4 (INTERFACES.md Contract B §4.1) — the tabbed shell. Tabs are graph-level, not
 * per-node: they stay switchable with no node selected, and each slot renders only in its own
 * tab (Radix `TabsContent` mounts only the active panel).
 */
describe('InspectorPanel — tabs (TASK-893 B4)', () => {
  it('renders all three tabs', () => {
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Config' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Problems/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Run' })).toBeTruthy();
  });

  it('clicking a tab reports the change — the panel does not manage its own tab state', () => {
    const onTabChange = vi.fn();
    renderWithProviders(<InspectorPanel tab="config" onTabChange={onTabChange} node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /^Problems/ }));
    expect(onTabChange).toHaveBeenCalledWith('problems');
  });

  it('the tabs stay available with no node selected — only the Config tab degrades', () => {
    renderWithProviders(
      <InspectorPanel tab="problems" onTabChange={vi.fn()} node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} problemsSlot={<p>Problems here</p>} />,
    );
    expect(screen.getByText('Problems here')).toBeTruthy();
    expect(screen.queryByText(/no node selected/i)).toBeNull();
  });

  it('renders problemsSlot only while the Problems tab is active', () => {
    renderWithProviders(
      <InspectorPanel tab="config" onTabChange={vi.fn()} node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} problemsSlot={<p>Problems here</p>} />,
    );
    expect(screen.queryByText('Problems here')).toBeNull();
  });

  it('renders runSlot only while the Run tab is active', () => {
    renderWithProviders(<InspectorPanel tab="run" onTabChange={vi.fn()} node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} runSlot={<p>Run panel here</p>} />);
    expect(screen.getByText('Run panel here')).toBeTruthy();
  });

  it('shows a count badge on the Problems tab when there are problems', () => {
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} problemCount={3} />);
    expect(screen.getByRole('tab', { name: /^Problems/ }).textContent).toContain('3');
  });

  it('shows no badge when there are no problems', () => {
    renderWithProviders(<InspectorPanel tab="config" onTabChange={vi.fn()} node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} problemCount={0} />);
    expect(screen.getByRole('tab', { name: /^Problems/ }).textContent).toBe('Problems');
  });

  it('keeps exactly one scroll container regardless of which tab is active', () => {
    const { container } = renderWithProviders(
      <InspectorPanel tab="config" onTabChange={vi.fn()} node={null} configSchema={undefined} problems={[]} onConfigChange={vi.fn()} />,
    );
    expect(container.querySelectorAll('.overflow-y-auto').length).toBe(1);
  });
});

/**
 * TASK-893 B5 (INTERFACES.md Contract B §4.2) — secondary DATA inputs render as inspector
 * fields bound to `config.inputs.<portName>`.
 */
describe('InspectorPanel — secondary input bindings (TASK-893 B5)', () => {
  function stubAgentsFetchForSecondaryInputs(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([{ slug: 'discharge', name: 'Discharge summary', task: 'TEXT_GENERATION', instruction: { variables: {} } }]),
      ),
    );
  }

  const UPSTREAM = [
    { id: 'trigger-1', label: 'Trigger', step: 1 },
    { id: 'extract-1', label: 'Extract entities', step: 2 },
  ];

  it('renders one binding field per declared secondary input', async () => {
    stubAgentsFetchForSecondaryInputs();
    renderWithProviders(
      <InspectorPanel
        tab="config"
        onTabChange={vi.fn()}
        node={{ id: 'agent-1', type: 'core.agent', position: { x: 0, y: 0 }, safetyClasses: [], config: { agentRef: { slug: 'discharge' } } }}
        configSchema={NODE_CONFIG_SCHEMAS['core.agent']}
        problems={[]}
        onConfigChange={vi.fn()}
        secondaryInputs={[{ name: 'context', primitive: 'text', required: false }]}
        upstreamNodes={UPSTREAM}
      />,
    );
    expect(await screen.findByLabelText(/^Context/)).toBeTruthy();
  });

  it('choosing an upstream node writes inputs.<portName>.fromNodeId, leaving the rest of the config untouched', async () => {
    stubAgentsFetchForSecondaryInputs();
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
    const onConfigChange = vi.fn();
    renderWithProviders(
      <InspectorPanel
        tab="config"
        onTabChange={vi.fn()}
        node={{ id: 'agent-1', type: 'core.agent', position: { x: 0, y: 0 }, safetyClasses: [], config: { agentRef: { slug: 'discharge' } } }}
        configSchema={NODE_CONFIG_SCHEMAS['core.agent']}
        problems={[]}
        onConfigChange={onConfigChange}
        secondaryInputs={[{ name: 'context', primitive: 'text', required: false }]}
        upstreamNodes={UPSTREAM}
      />,
    );
    const trigger = await screen.findByLabelText(/^Context/);
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByRole('option', { name: '2. Extract entities' }));
    expect(onConfigChange).toHaveBeenCalledWith(expect.objectContaining({ agentRef: { slug: 'discharge' }, inputs: { context: { fromNodeId: 'extract-1' } } }));
  });

  it('renders no secondary-input fields for a node type with none declared', () => {
    renderWithProviders(
      <InspectorPanel
        tab="config"
        onTabChange={vi.fn()}
        node={node()}
        configSchema={SCHEMA}
        problems={[]}
        onConfigChange={vi.fn()}
        secondaryInputs={[]}
        upstreamNodes={[]}
      />,
    );
    expect(screen.queryByText(/from an earlier step/i)).toBeNull();
  });
});
