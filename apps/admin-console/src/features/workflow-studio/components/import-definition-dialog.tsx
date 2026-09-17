'use client';

/**
 * `ImportDefinitionDialog` — TASK-885 (owner #4), "tenant admins import/export workflows as JSON".
 *
 * A SHORT dialog (rule 11 §1): pick a file, name the lineage, confirm. PRESENTATIONAL like
 * `CloneDefinitionDialog` — it owns no query and no mutation, so the list screen drives it and
 * the component stays testable without a QueryClient.
 *
 * Two things it deliberately does NOT do:
 *
 * - It does not validate the workflow. The parse is a SHAPE check so that choosing the wrong
 *   file costs a message instead of a round trip; whether the graph is publishable, and whether
 *   this tenant can resolve every reference it makes, are the server's answers.
 * - It does not resolve references itself. The 409 the gateway returns NAMES what is missing,
 *   and that message is surfaced verbatim — a paraphrase would drop the node ids that make it
 *   actionable.
 */
import { useRef, useState, type FormEvent } from 'react';
import { IconFileUpload } from '@tabler/icons-react';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
} from '@arcaai/ui';
import type { WorkflowDefinitionBundle } from '../api/types';
import { parseBundleJson, suggestImportSlug } from '../lib/bundle-io';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';

/** Mirrors the server's `targetSlug` grammar. Client-side only — the DTO re-validates it. */
const SLUG_PATTERN = /^[a-z0-9_]{2,48}$/;

export interface ImportDefinitionSubmission {
  targetSlug: string;
  name?: string;
  bundle: WorkflowDefinitionBundle;
}

export interface ImportDefinitionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (submission: ImportDefinitionSubmission) => void;
  confirming?: boolean;
  /** Server-side failure to surface verbatim — a 409 naming unresolvable references, or a quota. */
  error?: string | null;
}

const SOURCE_LABEL: Record<WorkflowDefinitionBundle['source']['tenantKind'], string> = {
  system: 'Platform template',
  global: 'Platform build tenant',
  tenant: 'Tenant workflow',
};

export function ImportDefinitionDialog({ open, onOpenChange, onConfirm, confirming, error }: ImportDefinitionDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [bundle, setBundle] = useState<WorkflowDefinitionBundle | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [targetSlug, setTargetSlug] = useState('');
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function reset() {
    setBundle(null);
    setFileName(null);
    setTargetSlug('');
    setName('');
    setLocalError(null);
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    const parsed = parseBundleJson(await file.text());
    if (!parsed.ok) {
      setBundle(null);
      setLocalError(parsed.reason);
      return;
    }
    setBundle(parsed.bundle);
    setLocalError(null);
    setTargetSlug(suggestImportSlug(parsed.bundle));
    setName(parsed.bundle.payload.name);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!bundle) {
      setLocalError('Choose a workflow bundle file first.');
      return;
    }
    if (!SLUG_PATTERN.test(targetSlug)) {
      setLocalError('The slug must be 2–48 lowercase letters, digits or underscores.');
      return;
    }
    setLocalError(null);
    onConfirm({ targetSlug, name: name.trim() || undefined, bundle });
  }

  const message = localError ?? error ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className={DIALOG_SIZE_CLASS.md}>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Import a workflow</DialogTitle>
            <DialogDescription>
              Imports a workflow exported from any tenant as a new draft here. Its prompt templates, document templates, agents and models are matched
              to yours by name — the import is refused, naming them, if any are missing.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="py-4">
            <Field>
              <FieldLabel htmlFor="import-file">Bundle file *</FieldLabel>
              <input
                ref={fileInputRef}
                id="import-file"
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => void handleFile(event.target.files?.[0])}
              />
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
                  <IconFileUpload aria-hidden />
                  Choose file
                </Button>
                {fileName ? <span className="text-muted-foreground truncate text-sm">{fileName}</span> : null}
              </div>
              {bundle ? (
                <FieldDescription>
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{SOURCE_LABEL[bundle.source.tenantKind]}</Badge>
                    <span className="font-mono text-xs">
                      {bundle.source.slug} &middot; v{bundle.source.version}
                    </span>
                    <span>
                      {bundle.payload.references.length} reference{bundle.payload.references.length === 1 ? '' : 's'} to resolve
                    </span>
                  </span>
                </FieldDescription>
              ) : (
                <FieldDescription>A `.workflow-bundle.json` file exported from a workflow’s detail screen.</FieldDescription>
              )}
            </Field>

            <Field>
              <FieldLabel htmlFor="import-slug">Slug *</FieldLabel>
              <Input
                id="import-slug"
                value={targetSlug}
                onChange={(event) => setTargetSlug(event.target.value)}
                placeholder="discharge_summary_imported"
                autoComplete="off"
              />
              <FieldDescription>
                The workflow’s address in this tenant. Must not already be in use — an existing slug is refused, never silently versioned.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="import-name">Name</FieldLabel>
              <Input id="import-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
              <FieldDescription>Defaults to the exported name.</FieldDescription>
            </Field>

            {message ? <FieldError>{message}</FieldError> : null}
          </FieldGroup>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={confirming || !bundle}>
              {confirming ? 'Importing…' : 'Import'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
