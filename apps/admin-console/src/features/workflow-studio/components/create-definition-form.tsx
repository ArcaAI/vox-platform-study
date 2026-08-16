'use client';

/**
 * The `/workflow-studio/new` form (TASK-719 Task 16) — mints the first DRAFT row via `POST
 * admin/workflow-definitions` (`slug`, `name`, `paletteKey` are all required — `paletteKey` is
 * NOT optional, per `contracts/definition-api.contract.md`'s re-derivation), then routes to the
 * real editor at `/workflow-studio/:id`. Controlled state, no `react-hook-form` (README §2.5).
 */
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button, Field, FieldDescription, FieldError, FieldGroup, FieldLabel, Input } from '@arcaai/ui';
import { GatewayError } from '@/shared/api';
import { useCreateWorkflowDefinition } from '../api';

const SLUG_PATTERN = /^[a-z0-9_]{2,48}$/;

export function CreateDefinitionForm() {
  const router = useRouter();
  const createMutation = useCreateWorkflowDefinition();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [paletteKey, setPaletteKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!SLUG_PATTERN.test(slug)) {
      setError('Slug must be 2-48 lowercase letters, digits or underscores.');
      return;
    }
    try {
      const created = await createMutation.mutateAsync({ slug, name, paletteKey, graph: { version: 1, nodes: [], edges: [] } });
      toast.success('Draft created.');
      router.replace(`/workflow-studio/${encodeURIComponent(created.id)}`);
    } catch (cause) {
      const message = cause instanceof GatewayError ? cause.message : 'Failed to create the definition.';
      setError(message);
      toast.error(message);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="mx-auto flex w-full max-w-md flex-col gap-6">
      <FieldGroup>
        <Field data-invalid={error ? 'true' : undefined}>
          <FieldLabel htmlFor="new-definition-slug">Slug *</FieldLabel>
          <FieldDescription>Stable lineage key, e.g. discharge_summary. Cannot be changed later.</FieldDescription>
          <Input id="new-definition-slug" value={slug} onChange={(event) => setSlug(event.target.value)} required maxLength={48} />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-definition-name">Name *</FieldLabel>
          <Input id="new-definition-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={160} />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-definition-palette">Palette key *</FieldLabel>
          <FieldDescription>Which registered palette this definition targets, e.g. summarization.</FieldDescription>
          <Input id="new-definition-palette" value={paletteKey} onChange={(event) => setPaletteKey(event.target.value)} required maxLength={80} />
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Creating…' : 'Create draft'}
        </Button>
      </FieldGroup>
    </form>
  );
}
