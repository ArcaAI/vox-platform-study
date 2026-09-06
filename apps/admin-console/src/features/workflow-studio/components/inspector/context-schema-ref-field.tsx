'use client';

/**
 * `ContextSchemaRefField` — `core.trigger`'s ONE consultation-context schema binding (TASK-890
 * §3.4): inline authoring OR a reference onto one of the TENANT's own `ConsultationContextSchema`
 * rows, never both (`lib/context-schema-ref.ts` owns the two-key read/write). Withheld from the
 * generic renderer in `inspector-panel.tsx` the same way `AgentPickerField` withholds
 * `agentRef` — the schema's own `contextSchema` object otherwise draws as a raw-json `inline`
 * box, a free-text `contextSchemaId` UUID box and a bare `versionNumber` number box, none of
 * which show the tenant which schemas exist or what versions they have published.
 *
 * The schema OPTION list is `@/shared/catalog`'s `useContextSchemaCatalog` — the SAME read the
 * agents form (L5) uses for `Agent.contextSchemaId` — never a second implementation (rule 13
 * "features never import each other" is about FEATURES; `shared/` exists for exactly this).
 * The per-schema VERSION list has no shared equivalent yet, so it is this feature's own read
 * (`useContextSchemaVersions`, `api/hooks.ts`).
 */
import { useId } from 'react';
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@arcaai/ui';
import { useContextSchemaCatalog } from '@/shared/catalog';
import { useContextSchemaVersions } from '../../api/hooks';
import {
  readContextSchemaBinding,
  withContextSchemaMode,
  withContextSchemaReference,
  withContextSchemaVersion,
  type ContextSchemaMode,
} from '../../lib/context-schema-ref';
import { RawJsonField } from './raw-json-field';

const FOLLOW_LATEST = '__follow_latest__';

export interface ContextSchemaRefFieldProps {
  idPrefix: string;
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
  errors?: string[];
  disabled?: boolean;
}

export function ContextSchemaRefField({ idPrefix, config, onConfigChange, errors, disabled }: ContextSchemaRefFieldProps) {
  const uid = useId();
  const modeFieldName = `${idPrefix}-${uid}-context-schema-mode`;
  const schemaFieldId = `${idPrefix}-${uid}-context-schema-id`;
  const versionFieldId = `${idPrefix}-${uid}-context-schema-version`;

  const binding = readContextSchemaBinding(config);
  const catalog = useContextSchemaCatalog();
  const versions = useContextSchemaVersions(binding.mode === 'reference' ? binding.schemaId : null);

  const schemas = catalog.data ?? [];
  const bound = binding.schemaId ? (schemas.find((schema) => schema.id === binding.schemaId) ?? null) : null;
  const boundIsMissing = binding.schemaId != null && bound === null && catalog.isSuccess;

  function setMode(mode: ContextSchemaMode) {
    onConfigChange(withContextSchemaMode(config, mode));
  }

  return (
    <FieldSet data-invalid={(errors?.length ?? 0) > 0 ? 'true' : undefined}>
      <FieldLegend variant="label">Context schema</FieldLegend>
      <FieldDescription>
        The consultation-context object schema available to the whole session. The run payload is validated against it before any node runs.
      </FieldDescription>

      <RadioGroup value={binding.mode} onValueChange={(next) => setMode(next as ContextSchemaMode)} disabled={disabled} name={modeFieldName}>
        <Field orientation="horizontal">
          <RadioGroupItem value="reference" id={`${modeFieldName}-reference`} />
          <FieldLabel htmlFor={`${modeFieldName}-reference`}>Reference a tenant schema</FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem value="inline" id={`${modeFieldName}-inline`} />
          <FieldLabel htmlFor={`${modeFieldName}-inline`}>Author inline</FieldLabel>
        </Field>
      </RadioGroup>

      {binding.mode === 'inline' ? (
        <RawJsonField
          descriptor={{
            kind: 'raw-json',
            path: 'contextSchema.inline',
            label: 'Inline schema',
            required: false,
            reason: 'An inline schema is authored as raw JSON Schema.',
          }}
          value={binding.inline ?? {}}
          onChange={(next) => onConfigChange({ ...config, contextSchema: { inline: next } })}
          id={`${idPrefix}-${uid}-context-schema-inline`}
        />
      ) : catalog.isPending ? (
        <Skeleton className="h-9 w-full" />
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor={schemaFieldId}>Context schema</FieldLabel>
            <Select
              value={binding.schemaId ?? ''}
              onValueChange={(next) => onConfigChange(withContextSchemaReference(config, next || null))}
              disabled={disabled}
            >
              <SelectTrigger id={schemaFieldId} className="w-full">
                <SelectValue placeholder="Choose a context schema" />
              </SelectTrigger>
              <SelectContent>
                {schemas.map((schema) => (
                  <SelectItem key={schema.id} value={schema.id}>
                    {schema.name}
                    {schema.isDefault ? ' (tenant default)' : ''}
                  </SelectItem>
                ))}
                {boundIsMissing ? <SelectItem value={binding.schemaId as string}>{binding.schemaId} — not in the catalog</SelectItem> : null}
              </SelectContent>
            </Select>
            {schemas.length === 0 && !catalog.isError ? (
              <FieldDescription>No context schemas published yet — publish one under Context Schemas first.</FieldDescription>
            ) : null}
          </Field>

          {binding.schemaId ? (
            <Field>
              <FieldLabel htmlFor={versionFieldId}>Version</FieldLabel>
              {versions.isPending ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select
                  value={binding.versionNumber != null ? String(binding.versionNumber) : FOLLOW_LATEST}
                  onValueChange={(next) => onConfigChange(withContextSchemaVersion(config, next === FOLLOW_LATEST ? null : Number(next)))}
                  disabled={disabled}
                >
                  <SelectTrigger id={versionFieldId} className="w-full">
                    <SelectValue placeholder="Follow latest" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={FOLLOW_LATEST}>Follow latest{bound?.pinnedVersionNumber != null ? ` (currently v${bound.pinnedVersionNumber})` : ''}</SelectItem>
                    {(versions.data ?? []).map((row) => (
                      <SelectItem key={row.versionNumber} value={String(row.versionNumber)}>
                        v{row.versionNumber}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <FieldDescription>
                {binding.versionNumber != null
                  ? `Pinned to v${binding.versionNumber} — the run always validates against this version.`
                  : "Follows the schema's own pin — a republish changes what this trigger accepts."}
              </FieldDescription>
            </Field>
          ) : null}
        </>
      )}
    </FieldSet>
  );
}
