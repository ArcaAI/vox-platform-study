'use client';

/** Create form — no dialog chrome, hosted in the drawer's create mode (agents-screen precedent). */

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { useCreateContextSchema, useDepartments } from '../api/hooks';
import { CONTEXT_KIND_KEY_PATTERN, type ConsultationContextSchema, type ConsultationContextSchemaScope } from '../api/types';

export function CreateSchemaForm({ onCreated, onCancel }: { onCreated: (schema: ConsultationContextSchema) => void; onCancel: () => void }) {
  const createSchema = useCreateContextSchema();
  const departmentsQuery = useDepartments();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<ConsultationContextSchemaScope>('TENANT');
  const [departmentId, setDepartmentId] = useState('');

  const slugValid = CONTEXT_KIND_KEY_PATTERN.test(slug);
  const canSubmit = !!name.trim() && slugValid && (scope === 'TENANT' || !!departmentId);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    createSchema.mutate(
      { slug, name: name.trim(), description: description.trim() || undefined, scope, departmentId: scope === 'DEPARTMENT' ? departmentId : undefined },
      {
        onSuccess: (schema) => {
          toast.success(`Context schema "${schema.name}" created`);
          onCreated(schema);
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the context schema.'),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="create-schema-name">
          Name <span aria-hidden className="text-destructive">*</span>
        </Label>
        <Input id="create-schema-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="General Medicine Context" autoComplete="off" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="create-schema-slug">
          Slug <span aria-hidden className="text-destructive">*</span>
        </Label>
        <Input
          id="create-schema-slug"
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder="general_medicine_context"
          className="font-mono"
          autoComplete="off"
          aria-invalid={slug.length > 0 && !slugValid}
          required
        />
        <p className="text-muted-foreground text-xs">Stable identifier, unique per tenant — lowercase letters, digits, underscores (2-48 chars).</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="create-schema-description">Description</Label>
        <Textarea id="create-schema-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="create-schema-scope">Scope</Label>
        <Select
          value={scope}
          onValueChange={(next) => {
            setScope(next as ConsultationContextSchemaScope);
            if (next === 'TENANT') setDepartmentId('');
          }}
        >
          <SelectTrigger id="create-schema-scope" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="TENANT">TENANT — governs every consultation</SelectItem>
            <SelectItem value="DEPARTMENT">DEPARTMENT — governs one department</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {scope === 'DEPARTMENT' ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="create-schema-department">
            Department <span aria-hidden className="text-destructive">*</span>
          </Label>
          <Select value={departmentId} onValueChange={setDepartmentId}>
            <SelectTrigger id="create-schema-department" className="w-full">
              <SelectValue placeholder="Choose a department" />
            </SelectTrigger>
            <SelectContent>
              {(departmentsQuery.data ?? []).map((department) => (
                <SelectItem key={department.id} value={department.id}>
                  {department.code ?? department.name ?? department.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={createSchema.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit || createSchema.isPending}>
          {createSchema.isPending ? <Spinner /> : null}
          Create schema
        </Button>
      </div>
    </form>
  );
}
