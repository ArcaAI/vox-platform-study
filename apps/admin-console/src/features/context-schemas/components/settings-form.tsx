'use client';

/**
 * Settings tab — schema metadata under OCC (`PATCH :id`, If-Match required).
 * `scope`/`departmentId` are set once at creation and are NOT in
 * `UpdateConsultationContextSchemaRequest` — shown read-only here.
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
import { useUpdateContextSchema } from '../api/hooks';
import type { ConsultationContextSchema, ConsultationContextSchemaStatus } from '../api/types';

const STATUS_OPTIONS: ConsultationContextSchemaStatus[] = ['DRAFT', 'PUBLISHED', 'APPROVED'];

export function SettingsForm({
  schema,
  etag,
  onSaved,
  onReload,
}: {
  schema: ConsultationContextSchema;
  etag: string | null;
  onSaved: () => void;
  onReload: () => void;
}) {
  const uid = useId();
  const updateSchema = useUpdateContextSchema();
  const [name, setName] = useState(schema.name);
  const [description, setDescription] = useState(schema.description ?? '');
  const [isDefault, setIsDefault] = useState(schema.isDefault);
  const [status, setStatus] = useState<ConsultationContextSchemaStatus>(schema.status);
  const occError =
    updateSchema.error instanceof GatewayError && (updateSchema.error.isVersionConflict || updateSchema.error.isMissingPrecondition)
      ? updateSchema.error
      : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!etag) return;
    updateSchema.mutate(
      { id: schema.id, patch: { name: name.trim(), description: description.trim() || undefined, isDefault, status }, etag },
      {
        onSuccess: () => {
          toast.success('Schema updated');
          onSaved();
        },
        onError: (error) => {
          if (error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition)) return;
          toast.error(error instanceof GatewayError ? error.message : 'Could not update the schema.');
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
          updateSchema.reset();
        }}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>Slug</Label>
          <Input value={schema.slug} disabled className="font-mono" />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Scope</Label>
          <Input value={schema.departmentId ? `DEPARTMENT (${schema.departmentId})` : 'TENANT'} disabled />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-name`}>
          Name <span aria-hidden className="text-destructive">*</span>
        </Label>
        <Input id={`${uid}-name`} value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" required />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-description`}>Description</Label>
        <Textarea id={`${uid}-description`} value={description} onChange={(event) => setDescription(event.target.value)} rows={3} />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-status`}>Status</Label>
        <Select value={status} onValueChange={(next) => setStatus(next as ConsultationContextSchemaStatus)}>
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
        <p className="text-muted-foreground text-xs">Moving back to DRAFT makes the schema unservable without discarding its published versions.</p>
      </div>

      <div className="flex items-center justify-between gap-2 rounded-md border p-3">
        <div className="flex flex-col gap-0.5">
          <span id={`${uid}-default-label`} className="text-sm font-medium">
            Department default
          </span>
          <span className="text-muted-foreground text-xs">Discovery resolves to this schema for its scope.</span>
        </div>
        <Switch aria-labelledby={`${uid}-default-label`} checked={isDefault} onCheckedChange={setIsDefault} />
      </div>

      <div className="flex justify-end">
        <Button type="submit" disabled={!name.trim() || !etag || updateSchema.isPending}>
          {updateSchema.isPending ? <Spinner /> : null}
          Save changes
        </Button>
      </div>
    </form>
  );
}
