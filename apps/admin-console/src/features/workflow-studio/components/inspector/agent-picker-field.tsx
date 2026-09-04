'use client';

/**
 * `AgentPickerField` — the `core.agent` inspector's agent choice (TASK-864 B1, TASK-863 §3.6:
 * "an agent picker (published agents of the port-compatible task) with a Create agent deep
 * link"). Reads `GET /admin/agents?task=` through `useAgentOptions`; while that admin surface
 * is absent (404) or failing, it degrades to a plain slug box so a graph can still be authored
 * against a slug the admin knows — the reference is validated at publish either way.
 */
import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import { Field, FieldDescription, FieldError, FieldLabel, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@arcaai/ui';
import { useAgentOptions } from '../../api/hooks';

/** The task a `core.agent` node's agent must serve. Text generation until the picker learns to read the port wiring. */
export const DEFAULT_AGENT_TASK = 'TEXT_GENERATION';
const CREATE_AGENT_HREF = '/agents?create=1';

export interface AgentPickerFieldProps {
  id: string;
  value: string;
  onChange: (slug: string) => void;
  task?: string;
  errors?: string[];
  disabled?: boolean;
}

export function AgentPickerField({ id, value, onChange, task = DEFAULT_AGENT_TASK, errors, disabled }: AgentPickerFieldProps) {
  const options = useAgentOptions(task);
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
          {options.isError ? 'The agent list is unavailable — enter the published agent`s slug.' : `No published ${task.toLowerCase().replace(/_/g, ' ')} agent yet — enter a slug, or create one.`}{' '}
          <Link href={CREATE_AGENT_HREF} className="inline-flex items-center gap-1 underline">
            Create agent <IconExternalLink aria-hidden="true" className="size-3" />
          </Link>
        </FieldDescription>
        <Input id={id} value={value} disabled={disabled} className="font-mono" onChange={(event) => onChange(event.target.value)} />
        <FieldError errors={errors?.map((message) => ({ message }))} />
      </Field>
    );
  }

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>Agent *</FieldLabel>
      <FieldDescription>
        A published {task.toLowerCase().replace(/_/g, ' ')} agent, resolved tenant-first at run time.{' '}
        <Link href={CREATE_AGENT_HREF} className="inline-flex items-center gap-1 underline">
          Create agent <IconExternalLink aria-hidden="true" className="size-3" />
        </Link>
      </FieldDescription>
      <Select value={known ? value : ''} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder={value && !known ? `${value} (not in the list)` : 'Choose an agent'} />
        </SelectTrigger>
        <SelectContent>
          {agents.map((agent) => (
            <SelectItem key={agent.slug} value={agent.slug}>
              {agent.name} <span className="text-muted-foreground font-mono text-xs">{agent.slug}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError errors={errors?.map((message) => ({ message }))} />
    </Field>
  );
}
