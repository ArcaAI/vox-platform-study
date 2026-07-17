'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { UseMutationResult } from '@tanstack/react-query';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import type { TtsConfigRow, TtsPlatformCatalog, TtsVoiceBindings, UpdateTtsConfigRequest } from '../api';
import { bindingsDirty, buildSparsePatch, fieldDraftValue, mergeBindingDrafts, rowVoiceBindings, TTS_FIELD_GROUPS, type TtsField } from './tts-config-fields';
import { VoiceBindingsEditor } from './voice-bindings-editor';

export type TtsRowMutation = UseMutationResult<
  WithEtag<TtsConfigRow>,
  Error,
  { patch: Omit<UpdateTtsConfigRequest, 'expectedVersion'>; etag: string | null }
>;

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

function FieldEditor({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: TtsField;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}) {
  if (field.kind === 'switch') {
    return (
      <div className="flex items-center gap-2">
        <Switch id={id} checked={Boolean(value)} onCheckedChange={onChange} />
        <span className="text-muted-foreground font-mono text-xs">{value ? 'true' : 'false'}</span>
      </div>
    );
  }
  if (field.kind === 'select') {
    const options = field.options ?? [];
    // Escape hatch (TASK-506): a saved value outside the closed list keeps the
    // legacy free-text editor instead of silently coercing it into an option.
    if (typeof value === 'string' && value !== '' && !options.includes(value)) {
      return <Input id={id} value={value} onChange={(event) => onChange(event.target.value)} className="h-8 font-mono text-xs" />;
    }
    return (
      <Select value={String(value)} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-8 font-mono text-xs">
          <SelectValue placeholder="inherit" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option} className="font-mono text-xs">
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (field.kind === 'integer' || field.kind === 'fraction') {
    return (
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step={field.kind === 'fraction' ? 0.05 : 1}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 font-mono text-xs"
      />
    );
  }
  // string + list are both free text (list is comma-separated).
  return <Input id={id} value={String(value)} onChange={(event) => onChange(event.target.value)} className="h-8 font-mono text-xs" />;
}

/**
 * OCC save panel for the TTS config row (TASK-504 Phase 4). Sparse patch over
 * the current row; saves send If-Match from the read ETag (`"0"` on first
 * create). A 412/428 keeps local drafts and offers reload-merge (frame 08).
 */
export function TtsConfigForm({
  row,
  etag,
  mutation,
  onReloadLatest,
  successMessage,
  catalog,
  effectiveBindings,
}: {
  row: TtsConfigRow;
  etag: string | null;
  mutation: TtsRowMutation;
  onReloadLatest: () => void;
  successMessage: string;
  /** TASK-506 registry catalog; omitted (e.g. catalog fetch failed) hides the bindings editor. */
  catalog?: TtsPlatformCatalog;
  /** Effective merged bindings — used only for the editor's row-id union. */
  effectiveBindings?: TtsVoiceBindings;
}) {
  const uid = useId();
  const [drafts, setDrafts] = useState<Record<string, string | boolean>>({});
  const [bindingDrafts, setBindingDrafts] = useState<Record<string, Record<string, string>>>({});

  const savedBindings = rowVoiceBindings(row);
  const bindingsChanged = catalog !== undefined && bindingsDirty(savedBindings, bindingDrafts);
  const patch: Omit<UpdateTtsConfigRequest, 'expectedVersion'> = {
    ...buildSparsePatch(row, drafts),
    ...(bindingsChanged ? { voiceBindings: mergeBindingDrafts(savedBindings, bindingDrafts) } : {}),
  };
  const dirty = Object.keys(patch).length > 0;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    mutation.mutate(
      { patch, etag },
      {
        onSuccess: () => {
          toast.success(successMessage);
          setDrafts({});
          setBindingDrafts({});
        },
        onError: (error) => {
          if (!isOccError(error)) toast.error(error.message);
        },
      },
    );
  }

  return (
    // noValidate: fractional steps trip float-modulo stepMismatch; the gateway
    // DTO validates ranges after we parse the drafts.
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4" aria-label="TTS config save panel">
      <div className="grid gap-4 lg:grid-cols-2">
        {TTS_FIELD_GROUPS.map((group) => (
          <Card key={group.title} className="gap-3 p-4">
            <h3 className="text-sm font-semibold">{group.title}</h3>
            <div className="flex flex-col gap-3">
              {group.fields.map((field) => {
                const id = `${uid}-${String(field.key)}`;
                const value = drafts[field.key as string] ?? fieldDraftValue(field, row);
                return (
                  <div key={String(field.key)} className="flex flex-col gap-1.5">
                    <Label htmlFor={id} className="text-muted-foreground text-xs font-medium">
                      {field.label}
                    </Label>
                    <FieldEditor
                      id={id}
                      field={field}
                      value={value}
                      onChange={(next) => setDrafts((current) => ({ ...current, [field.key as string]: next }))}
                    />
                    {field.hint ? <p className="text-muted-foreground text-xs">{field.hint}</p> : null}
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
        {catalog ? (
          <VoiceBindingsEditor
            uid={uid}
            catalog={catalog}
            saved={savedBindings}
            effective={effectiveBindings}
            drafts={bindingDrafts}
            onDraftChange={(voiceId, provider, value) =>
              setBindingDrafts((current) => ({ ...current, [voiceId]: { ...current[voiceId], [provider]: value } }))
            }
          />
        ) : null}
      </div>
      <OccConflictAlert
        error={mutation.error}
        onReload={() => {
          // Drafts stay in memory (reload-merge: no silent loss).
          mutation.reset();
          onReloadLatest();
        }}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {dirty ? <span className="text-muted-foreground text-sm">Unsaved changes</span> : null}
        <Button type="submit" disabled={!dirty || mutation.isPending}>
          {mutation.isPending ? <Spinner /> : null}
          Save &middot; If-Match
        </Button>
      </div>
    </form>
  );
}
