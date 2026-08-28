'use client';

/**
 * Settings tab — template metadata under OCC (`PATCH :id`, If-Match required).
 *
 * `status` and `isDefault` are the two controls that decide whether this
 * template is SERVED at all (`isServable` + `findDefaultForTenant`), so both
 * carry prose saying so: a published, pinned template left on DRAFT, or one
 * that is simply not the default, silently falls back to the platform SOAP
 * shape with no error anywhere.
 */

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { useUpdateDocumentTemplate } from '../api/hooks';
import type { DocumentTemplate, DocumentTemplateStatus } from '../api/types';

const STATUS_OPTIONS: DocumentTemplateStatus[] = ['DRAFT', 'PUBLISHED', 'APPROVED'];

export function TemplateSettingsForm({
  template,
  etag,
  onSaved,
  onReload,
}: {
  template: DocumentTemplate;
  etag: string | null;
  onSaved: () => void;
  onReload: () => void;
}) {
  const uid = useId();
  const updateTemplate = useUpdateDocumentTemplate();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description ?? '');
  const [isDefault, setIsDefault] = useState(template.isDefault);
  const [status, setStatus] = useState<DocumentTemplateStatus>(template.status);
  const occError =
    updateTemplate.error instanceof GatewayError && (updateTemplate.error.isVersionConflict || updateTemplate.error.isMissingPrecondition)
      ? updateTemplate.error
      : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!etag) return;
    updateTemplate.mutate(
      { id: template.id, patch: { name: name.trim(), description: description.trim() || undefined, isDefault, status }, etag },
      {
        onSuccess: () => {
          toast.success('Template updated');
          onSaved();
        },
        onError: (error) => {
          if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
          toast.error(error instanceof GatewayError ? error.message : 'Could not update the template.');
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <OccConflictAlert
        error={occError}
        onReload={() => {
          onReload();
          updateTemplate.reset();
        }}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-slug`}>Slug</Label>
          <Input id={`${uid}-slug`} value={template.slug} disabled className="font-mono" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-pin`}>Pinned version</Label>
          <Input id={`${uid}-pin`} value={template.pinnedVersionNumber != null ? `v${template.pinnedVersionNumber}` : 'none — never published'} disabled />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-name`}>
          Name{' '}
          <span aria-hidden className="text-destructive">
            *
          </span>
        </Label>
        <Input id={`${uid}-name`} value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-description`}>Description</Label>
        <Textarea id={`${uid}-description`} value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-status`}>Status</Label>
        <Select value={status} onValueChange={(next) => setStatus(next as DocumentTemplateStatus)}>
          <SelectTrigger id={`${uid}-status`} className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          Only PUBLISHED or APPROVED templates are served. Moving back to DRAFT makes this template unservable without discarding its versions — generation
          then falls back to the platform shape.
        </p>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-md border p-3">
        <div className="flex flex-col gap-0.5">
          <span id={`${uid}-default-label`} className="text-sm font-medium">
            Tenant default
          </span>
          <span className="text-muted-foreground text-xs">
            A generation node that names no template resolves the default — and only the default. A tenant with no default gets the platform shape.
          </span>
        </div>
        <Switch aria-labelledby={`${uid}-default-label`} checked={isDefault} onCheckedChange={setIsDefault} />
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={!name.trim() || !etag || updateTemplate.isPending}>
          {updateTemplate.isPending ? <Spinner /> : null}
          Save changes
        </Button>
      </div>
    </form>
  );
}
