'use client';

/** Create form — no dialog chrome, hosted in the drawer's create mode (the context-schemas precedent). */

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { useCreateDocumentTemplate } from '../api/hooks';
import { DOCUMENT_SECTION_KEY_PATTERN, type DocumentTemplate } from '../api/types';

export function CreateTemplateForm({ onCreated, onCancel }: { onCreated: (template: DocumentTemplate) => void; onCancel: () => void }) {
  const createTemplate = useCreateDocumentTemplate();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isDefault, setIsDefault] = useState(false);

  const slugValid = DOCUMENT_SECTION_KEY_PATTERN.test(slug);
  const canSubmit = !!name.trim() && slugValid;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    createTemplate.mutate(
      { slug, name: name.trim(), description: description.trim() || undefined, isDefault },
      {
        onSuccess: (template) => {
          toast.success(`Document template "${template.name}" created`);
          onCreated(template);
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the document template.'),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="create-template-name">
          Name{' '}
          <span aria-hidden className="text-destructive">
            *
          </span>
        </Label>
        <Input
          id="create-template-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Discharge Summary"
          autoComplete="off"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="create-template-slug">
          Slug{' '}
          <span aria-hidden className="text-destructive">
            *
          </span>
        </Label>
        <Input
          id="create-template-slug"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="discharge_summary"
          className="font-mono"
          autoComplete="off"
          aria-invalid={slug.length > 0 && !slugValid}
          required
        />
        <p className="text-muted-foreground text-xs">Stable identifier, unique per tenant — lowercase letters, digits, underscores (2-48 chars).</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="create-template-description">Description</Label>
        <Textarea id="create-template-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
      </div>
      <div className="flex items-center justify-between gap-2 rounded-md border p-3">
        <div className="flex flex-col gap-0.5">
          <span id="create-template-default-label" className="text-sm font-medium">
            Make this the tenant default
          </span>
          <span className="text-muted-foreground text-xs">It still needs a published version before anything is served from it.</span>
        </div>
        <Switch aria-labelledby="create-template-default-label" checked={isDefault} onCheckedChange={setIsDefault} />
      </div>
      <p className="text-muted-foreground text-xs">A template is born DRAFT with no shape. Publish one from the Shape tab to give it a version.</p>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={createTemplate.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || createTemplate.isPending}>
          {createTemplate.isPending ? <Spinner /> : null}
          Create template
        </Button>
      </div>
    </form>
  );
}
