'use client';

/**
 * The `/workflow-studio/new` form — mints the first DRAFT row via `POST
 * admin/workflow-definitions` (`slug`, `name`, `paletteKey` are all required — `paletteKey` is
 * NOT optional, per `contracts/definition-api.contract.md`'s re-derivation), then routes to the
 * real editor at `/workflow-studio/:id`. Controlled state, no `react-hook-form`
 *
 * TASK-890 (black-box J4-F7): `Palette key *` is a PICKER over the registry's own palette keys,
 * not free text. The set is code-owned, so a typed key was a way to mint a definition targeting a
 * palette that does not exist, with nothing in the form saying which ones do. The free-text box
 * survives as the fallback for a registry read that FAILED — a broken catalogue read should
 * degrade authoring, not block it — and never as an equal alternative.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@arcaai/ui';
import { GatewayError } from '@/shared/api';
import { useCreateWorkflowDefinition, useWorkflowNodeRegistry } from '../api';
import { paletteKeyOptions } from '../lib/palette-keys';
import { humanizeKey } from '../lib/schema-form';

const SLUG_PATTERN = /^[a-z0-9_]{2,48}$/;

export function CreateDefinitionForm() {
  const router = useRouter();
  const createMutation = useCreateWorkflowDefinition();
  const registry = useWorkflowNodeRegistry();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [paletteKey, setPaletteKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const paletteOptions = useMemo(() => paletteKeyOptions(registry.data?.nodes ?? []), [registry.data]);
  // Only a read that RESOLVED with no palettes, or one that failed, falls back to free text.
  const freeTextPalette = registry.isError || (registry.isSuccess && paletteOptions.length === 0);

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
          <FieldDescription>Which registered palette this definition targets. Set once, at create.</FieldDescription>
          {registry.isPending ? (
            <Skeleton className="h-9 w-full" />
          ) : freeTextPalette ? (
            <>
              <Input id="new-definition-palette" value={paletteKey} onChange={(event) => setPaletteKey(event.target.value)} required maxLength={80} />
              <FieldDescription>
                The node registry could not be read, so the palette list is unavailable — type the key (e.g. core) to continue.
              </FieldDescription>
            </>
          ) : (
            <Select value={paletteKey} onValueChange={setPaletteKey} required>
              <SelectTrigger id="new-definition-palette" className="w-full">
                <SelectValue placeholder="Choose a palette" />
              </SelectTrigger>
              <SelectContent>
                {paletteOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key} data-value={option.key}>
                    {humanizeKey(option.key)}
                    {option.deprecated ? ' (deprecated)' : ''} <span className="text-muted-foreground font-mono text-xs">{option.key}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <Button type="submit" disabled={createMutation.isPending}>
          {createMutation.isPending ? 'Creating…' : 'Create draft'}
        </Button>
      </FieldGroup>
    </form>
  );
}
