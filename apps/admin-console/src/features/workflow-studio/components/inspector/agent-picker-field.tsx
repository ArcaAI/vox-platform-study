'use client';

/**
 * `AgentPickerField` — the `core.agent` inspector's agent choice (TASK-864 B1, TASK-863 §3.6:
 * "an agent picker (published agents of the port-compatible task) with a Create agent deep
 * link"). Reads `GET /admin/agents` through `useAgentOptions`; while that admin surface
 * is absent (404) or failing, it degrades to a plain slug box so a graph can still be authored
 * against a slug the admin knows — the reference is validated at publish either way.
 *
 * TASK-949 L0 — the list is NOT filtered by task, and must not be.
 *
 * It used to ask for `task=TEXT_GENERATION` unconditionally, which made every non-LLM agent
 * unreachable: the seeded ArcaAI graphs reference `realtime-transcription` (SPEECH_TO_TEXT) and
 * `medical-ner` (NAMED_ENTITY_RECOGNITION) from `core.agent` nodes, so both rendered as
 * "<slug> (not in the list)" with no way to re-select them — while the dropdown offered 25
 * summarization agents, any of which would have silently rewired the node.
 *
 * A `core.agent` is deliberately task-agnostic: it "declares the union of every task's sockets"
 * (`node-ports.ts`) and the realtime lane dispatches on the RESOLVED agent task. Options are
 * therefore GROUPED by task rather than filtered to one, so a long summarization list cannot
 * bury the single ASR agent.
 */
import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@arcaai/ui';
import { useAgentOptions } from '../../api/hooks';

const CREATE_AGENT_HREF = '/agents?create=1';

/**
 * `SPEECH_TO_TEXT` -> `Speech to text`. The task vocabulary is the contract's; this only titles it.
 *
 * TOTAL by construction. `AgentOption.task` is required on the wire, but this label is the only
 * thing standing between one malformed row and a blank Config tab — the picker renders inside the
 * inspector with no error boundary of its own, so a throw here takes the whole panel down. An
 * untasked row groups under a neutral heading instead.
 */
export function agentTaskLabel(task: string | undefined): string {
  if (!task) return 'Other';
  const words = task.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface AgentPickerFieldProps {
  id: string;
  value: string;
  onChange: (slug: string) => void;
  errors?: string[];
  disabled?: boolean;
}

export function AgentPickerField({ id, value, onChange, errors, disabled }: AgentPickerFieldProps) {
  const options = useAgentOptions(undefined);
  const invalid = (errors?.length ?? 0) > 0 ? 'true' : undefined;

  if (options.isPending) {
    return (
      <Field>
        <FieldLabel htmlFor={id}>Agent *</FieldLabel>
        <Skeleton className="h-9 w-full" />
      </Field>
    );
  }

  const agents = options.data ?? [];
  const known = agents.some((agent) => agent.slug === value);

  if (options.isError || agents.length === 0) {
    return (
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={id}>Agent slug *</FieldLabel>
        <FieldDescription>
          {options.isError ? 'The agent list is unavailable — enter the published agent`s slug.' : 'No published agent yet — enter a slug, or create one.'}{' '}
          <Link href={CREATE_AGENT_HREF} className="inline-flex items-center gap-1 underline">
            Create agent <IconExternalLink aria-hidden="true" className="size-3" />
          </Link>
        </FieldDescription>
        <Input id={id} value={value} disabled={disabled} className="font-mono" onChange={(event) => onChange(event.target.value)} />
        <FieldError errors={errors?.map((message) => ({ message }))} />
      </Field>
    );
  }

  // Grouped by task, each group in first-seen order — the server already returns a stable order,
  // and re-sorting here would fight it for no gain.
  const byTask = new Map<string, typeof agents>();
  for (const agent of agents) {
    const key = agent.task ?? '';
    const bucket = byTask.get(key);
    if (bucket) bucket.push(agent);
    else byTask.set(key, [agent]);
  }

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>Agent *</FieldLabel>
      <FieldDescription>
        A published agent, resolved tenant-first at run time.{' '}
        <Link href={CREATE_AGENT_HREF} className="inline-flex items-center gap-1 underline">
          Create agent <IconExternalLink aria-hidden="true" className="size-3" />
        </Link>
      </FieldDescription>
      <Select value={known ? value : ''} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={value && !known ? `${value} (not in the list)` : 'Choose an agent'} />
        </SelectTrigger>
        <SelectContent>
          {[...byTask.entries()].map(([task, taskAgents]) => (
            <SelectGroup key={task}>
              <SelectLabel>{agentTaskLabel(task)}</SelectLabel>
              {taskAgents.map((agent) => (
                <SelectItem key={agent.slug} value={agent.slug}>
                  {agent.name} <span className="text-muted-foreground font-mono text-xs">{agent.slug}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      <FieldError errors={errors?.map((message) => ({ message }))} />
    </Field>
  );
}
