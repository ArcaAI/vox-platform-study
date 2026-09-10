'use client';

/**
 * `AgentParametersView` — a published agent's task-typed configuration, READ-ONLY.
 *
 * TASK-949 L1. Driven by `AGENT_PARAMETER_SCHEMAS[task]`, the same contract the agents screen's
 * editor renders and the gateway validates against, so a field this shows is a field the platform
 * actually honours. It renders VALUES, not disabled controls: the caller is the workflow studio's
 * `core.agent` inspector, where the question is "what will this step do", and thirty greyed-out
 * inputs answer it badly.
 *
 * ## D-4 — a value must name the tier that supplied it
 *
 * An ASR field resolves agent -> model profile -> engine default (TASK-934 OD-3), and an LLM
 * generation field can additionally be overridden by the node. Rendering the resolved number
 * alone would attribute the model's own geometry to the agent, which is exactly the confusion
 * that made a decode regression hard to see. So each row resolves in precedence order and says
 * where the winner came from whenever that is not the agent itself.
 *
 * Knobs no tier sets are NOT given a row each — an ASR agent declares ~30 and most sit at engine
 * defaults. They collapse into one muted line per group, so the view stays complete without
 * burying the handful of values somebody actually chose.
 */
import { AGENT_PARAMETER_SCHEMAS, type AgentTask } from '@arcaai/workflow-contract';
import { Badge } from '@arcaai/ui';
import { getPath, isGroup, labelOf, props, type Schema, type Value } from './schema-walk';

export interface AgentParametersViewProps {
  task: AgentTask;
  /** The agent's own `parameters`. */
  value: Value | null | undefined;
  /** Values the CALL SITE overrides, by dotted path — a `core.agent` node's `overrides.generation.*`. */
  overrides?: Record<string, unknown>;
  /** Values inherited when the agent leaves a field unset, by dotted path — the ASR model profile. */
  inherited?: Record<string, unknown>;
  /** Label for the `inherited` tier, shown on rows it supplies. */
  inheritedLabel?: string;
}

type Resolution = { value: unknown; source: 'override' | 'agent' | 'inherited' } | null;

function resolve(path: string, agentValue: unknown, overrides?: Record<string, unknown>, inherited?: Record<string, unknown>): Resolution {
  if (overrides && overrides[path] !== undefined) return { value: overrides[path], source: 'override' };
  if (agentValue !== undefined) return { value: agentValue, source: 'agent' };
  if (inherited && inherited[path] !== undefined) return { value: inherited[path], source: 'inherited' };
  return null;
}

/** Values are configuration, so they render as literals — `true`, not a tick; `a, b`, not `Array(2)`. */
function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length > 0 ? value.map(String).join(', ') : '—';
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function ParameterRow({ label, resolution, inheritedLabel }: { label: string; resolution: NonNullable<Resolution>; inheritedLabel: string }) {
  return (
    <div data-slot="parameter-row" className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-xs break-all">{formatValue(resolution.value)}</span>
        {resolution.source === 'override' ? (
          <Badge variant="secondary" className="px-1 py-0 text-[10px]">
            overridden here
          </Badge>
        ) : null}
        {resolution.source === 'inherited' ? <span className="text-muted-foreground text-[10px]">{inheritedLabel}</span> : null}
      </span>
    </div>
  );
}

function SchemaSection({
  schema,
  path,
  value,
  overrides,
  inherited,
  inheritedLabel,
}: {
  schema: Schema;
  path: string[];
  value: Value;
  overrides?: Record<string, unknown>;
  inherited?: Record<string, unknown>;
  inheritedLabel: string;
}) {
  const rows: React.ReactNode[] = [];
  const groups: React.ReactNode[] = [];
  const unset: string[] = [];

  for (const [name, child] of Object.entries(props(schema))) {
    const childPath = [...path, name];
    const dotted = childPath.join('.');

    if (isGroup(child)) {
      groups.push(
        <SchemaSection
          key={name}
          schema={child}
          path={childPath}
          value={value}
          overrides={overrides}
          inherited={inherited}
          inheritedLabel={inheritedLabel}
        />,
      );
      continue;
    }

    const resolution = resolve(dotted, getPath(value, childPath), overrides, inherited);
    if (resolution) rows.push(<ParameterRow key={name} label={labelOf(name)} resolution={resolution} inheritedLabel={inheritedLabel} />);
    else unset.push(labelOf(name));
  }

  const body = (
    <>
      {rows}
      {unset.length > 0 ? <p className="text-muted-foreground pt-1 text-[10px]">{unset.join(', ')} — engine default</p> : null}
      {groups}
    </>
  );

  // The root has no legend of its own; a nested group is titled by its schema key.
  if (path.length === 0) return <div className="flex flex-col gap-1">{body}</div>;

  const anythingHere = rows.length > 0 || groups.length > 0 || unset.length > 0;
  if (!anythingHere) return null;

  return (
    <div className="flex flex-col gap-1 border-l pl-3">
      <p className="text-foreground text-xs font-medium">{labelOf(path[path.length - 1])}</p>
      {body}
    </div>
  );
}

export function AgentParametersView({ task, value, overrides, inherited, inheritedLabel = 'from the model profile' }: AgentParametersViewProps) {
  const schema = AGENT_PARAMETER_SCHEMAS[task] as Schema | undefined;
  const parameters = (value ?? {}) as Value;

  if (!schema) return <p className="text-muted-foreground text-xs">This task declares no parameters.</p>;

  const hasAny = Object.keys(parameters).length > 0 || Object.keys(overrides ?? {}).length > 0 || Object.keys(inherited ?? {}).length > 0;
  if (!hasAny) return <p className="text-muted-foreground text-xs">No parameters set — every knob runs at its engine default.</p>;

  return <SchemaSection schema={schema} path={[]} value={parameters} overrides={overrides} inherited={inherited} inheritedLabel={inheritedLabel} />;
}
