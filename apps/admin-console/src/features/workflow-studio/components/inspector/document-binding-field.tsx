'use client';

/**
 * DD-2's document binding as ONE control.
 *
 * The binding is two config keys — `documentTemplateId` + `documentVersionNumber` — and the
 * Studio inspector generates its form from the node's JSON Schema, so until now they surfaced
 * as two raw fields: a free-text UUID box and a bare number box. An admin could not see which
 * templates exist, could not tell whether a pin was behind, and could typo a UUID into a
 * published clinical graph. This replaces both with a picker over the tenant's servable
 * templates plus a version pin that reports its own staleness.
 *
 * ## The three pin states, and the one that must NOT be flagged
 *
 * The treatment deliberately mirrors `PromptBindingsRail` , including the part that is
 * easy to get wrong:
 *
 *   pinned + behind "New v5 available" — the template moved on without this node
 *   pinned + current the pin, quietly
 *   unpinned "Follows the template" — NOT flagged
 *
 * An unpinned node tracks the template on purpose. Badging it would put a permanent warning on
 * a correct configuration and train admins to ignore the badge that does mean something.
 *
 * A fourth state exists in the data and is reported separately rather than folded into
 * "behind": `POST /admin/document-templates/:id/pin` is explicitly the ROLLBACK path, so a
 * template can move BACKWARDS past a node's pin. Calling that "New v2 available" on a node
 * already at v3 would be false.
 *
 * ## Why the catalog read lives in `shared/`
 *
 * `features/document-templates` owns the authoring surface and its own fuller types; features
 * never import each other (rule 13 §Structure), so the read-only lookup was lifted to
 * `@/shared/catalog` — the same place, and for the same reason, that `TextProvider` already
 * lives. The authoritative editor stays `/document-templates`, reached here by a plain href.
 *
 * ## Writes
 *
 * Both keys are OPTIONAL on all five generation schemas, which is what keeps every
 * already-published graph valid. This control never writes a pin the admin did not choose and
 * never writes `0` — `withDocumentTemplate`/`withDocumentVersion` (`lib/document-binding.ts`)
 * encode "no pin" by ABSENCE, exactly as the compiler reads it.
 */

import { useId } from 'react';
import Link from 'next/link';
import { IconAlertTriangle, IconExternalLink, IconInfoCircle } from '@tabler/icons-react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@arcaai/ui';
import {
  PLATFORM_FALLBACK_SECTION_TITLES,
  isServableDocumentTemplate,
  useDocumentTemplateCatalog,
  useDocumentTemplateVersionCatalog,
  type CatalogDocumentTemplate,
} from '@/shared/catalog';
import { documentPinState, readDocumentBinding, withDocumentTemplate, withDocumentVersion, type DocumentPinState } from '../../lib/document-binding';

/** Radix `Select` reserves the empty string for "no value" — route both "nothing selected"
 *  meanings through sentinels, the same convention `PromptTemplatePicker` uses. */
const TENANT_DEFAULT = '__tenant_default__';
const FOLLOWS_TEMPLATE = '__follows_template__';

const CATALOG_HREF = '/document-templates';

export interface DocumentBindingFieldProps {
  /** Namespaces the generated ids — the node id, matching `field-renderers.tsx`. */
  idPrefix: string;
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
  /** Server `WorkflowFinding.message` strings at `documentTemplateId`. */
  templateErrors?: string[];
  /** Server `WorkflowFinding.message` strings at `documentVersionNumber`. */
  versionErrors?: string[];
}

function CatalogLink() {
  return (
    <Link href={CATALOG_HREF} className="text-foreground inline-flex w-fit items-center gap-1 text-xs hover:underline">
      <IconExternalLink aria-hidden className="size-3" />
      Manage document templates
    </Link>
  );
}

/**
 * The fallback is a NORMAL state, not an error: `resolveForGeneration` fails OPEN to the
 * platform SOAP shape so a live consultation never dies for want of a template. Reported as
 * `role="status"` — `Alert` hardcodes `role="alert"`, an ASSERTIVE live region that interrupts
 * on mount, which is right for a rejection and wrong for a standing description of current
 * state (WCAG 4.1.3).
 */
function PlatformFallbackNotice() {
  return (
    <Alert role="status">
      <IconInfoCircle aria-hidden />
      <AlertTitle>Generating the platform SOAP Note shape</AlertTitle>
      <AlertDescription>
        <p>
          This tenant has no published, servable document template, so generation falls back to the platform shape (
          {PLATFORM_FALLBACK_SECTION_TITLES.join(', ')}). Nothing is broken — that is what is being produced today.
        </p>
        <p>Publish a template to bind a specific shape to this node.</p>
        <CatalogLink />
      </AlertDescription>
    </Alert>
  );
}

function UnknownTemplateNotice({ templateId }: { templateId: string }) {
  return (
    <Alert role="status">
      <IconAlertTriangle aria-hidden />
      <AlertTitle>This node names a template that is not in the catalog</AlertTitle>
      <AlertDescription>
        <p>
          <span className="font-mono break-all">{templateId}</span> is not in this tenant’s document-template catalog. It may have been deleted, or it
          may belong to another tenant. The value is left exactly as it is — pick a template below to replace it.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function templateOptionLabel(template: CatalogDocumentTemplate): string {
  const pin = template.pinnedVersionNumber != null ? ` (v${template.pinnedVersionNumber})` : '';
  const servable = isServableDocumentTemplate(template) ? '' : ' — not servable';
  return `${template.name}${pin}${servable}`;
}

/** The pin state in words. Never colour alone, and never a badge on a legitimate configuration. */
function PinStatus({ state, pinned, templatePin }: { state: DocumentPinState; pinned: number | null; templatePin: number | null }) {
  if (state === 'unpinned') {
    return (
      <FieldDescription>
        Follows the template — currently v{templatePin ?? '—'}. Republishing the template changes what this node produces.
      </FieldDescription>
    );
  }
  if (state === 'current') {
    return <FieldDescription>Pinned to v{pinned} — the version this template serves.</FieldDescription>;
  }
  if (state === 'behind') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">New v{templatePin} available</Badge>
        <FieldDescription>
          Pinned to v{pinned}; the template now serves v{templatePin}. This node keeps producing v{pinned}’s shape until you move the pin.
        </FieldDescription>
      </div>
    );
  }
  if (state === 'ahead') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">Template rolled back to v{templatePin}</Badge>
        <FieldDescription>
          Pinned to v{pinned}, which the template no longer serves. Move the pin to v{templatePin} unless this node is meant to stay on the older shape.
        </FieldDescription>
      </div>
    );
  }
  return <FieldDescription>Pinned to v{pinned}. This template has no published version to compare against.</FieldDescription>;
}

export function DocumentBindingField({ idPrefix, config, onConfigChange, templateErrors, versionErrors }: DocumentBindingFieldProps) {
  const uid = useId();
  const templateFieldId = `${idPrefix}-${uid}-documentTemplateId`;
  const versionFieldId = `${idPrefix}-${uid}-documentVersionNumber`;

  const binding = readDocumentBinding(config);
  const catalog = useDocumentTemplateCatalog();
  const versions = useDocumentTemplateVersionCatalog(binding.templateId);

  const templates = catalog.data ?? [];
  const servable = templates.filter(isServableDocumentTemplate);
  const bound = binding.templateId ? (templates.find((template) => template.id === binding.templateId) ?? null) : null;
  const boundIsMissing = binding.templateId != null && bound === null && catalog.isSuccess;
  // A bound template that is not itself servable is still offered, so the Select shows the truth
  // rather than an empty trigger over a value that is really there.
  const options = bound && !servable.includes(bound) ? [...servable, bound] : servable;

  const templatePin = bound?.pinnedVersionNumber ?? null;
  const state = documentPinState(binding.pinnedVersionNumber, templatePin);
  const showPicker = options.length > 0 || binding.templateId != null;

  return (
    <FieldSet data-invalid={(templateErrors?.length ?? 0) + (versionErrors?.length ?? 0) > 0 ? 'true' : undefined}>
      <FieldLegend variant="label">Document shape</FieldLegend>
      <FieldDescription>
        Optional. A generation node binds ONE document shape here, statically — it is frozen for the session, never chosen at runtime.
      </FieldDescription>

      {catalog.isPending ? (
        <Skeleton className="h-9 w-full" />
      ) : catalog.error ? (
        <Alert variant="destructive">
          <IconAlertTriangle aria-hidden />
          <AlertTitle>Couldn’t load the document-template catalog</AlertTitle>
          <AlertDescription>
            <p>{catalog.error instanceof Error ? catalog.error.message : 'The request failed.'}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void catalog.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <>
          {options.length === 0 ? <PlatformFallbackNotice /> : null}
          {boundIsMissing ? <UnknownTemplateNotice templateId={binding.templateId as string} /> : null}

          {showPicker ? (
            <>
              <Field data-invalid={(templateErrors?.length ?? 0) > 0 ? 'true' : undefined}>
                <FieldLabel htmlFor={templateFieldId}>Document template</FieldLabel>
                <Select
                  value={binding.templateId ?? TENANT_DEFAULT}
                  onValueChange={(next) => onConfigChange(withDocumentTemplate(config, next === TENANT_DEFAULT ? null : next))}
                >
                  <SelectTrigger id={templateFieldId}>
                    <SelectValue placeholder="Select a document template…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={TENANT_DEFAULT}>— Tenant default —</SelectItem>
                    {options.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {templateOptionLabel(template)}
                      </SelectItem>
                    ))}
                    {boundIsMissing ? <SelectItem value={binding.templateId as string}>{binding.templateId} — not in the catalog</SelectItem> : null}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Leave this on the tenant default and generation resolves the tenant’s default template — or the platform SOAP shape when there is
                  none.
                </FieldDescription>
                <CatalogLink />
                <FieldError errors={templateErrors?.map((message) => ({ message }))} />
              </Field>

              {binding.templateId ? (
                <Field data-invalid={(versionErrors?.length ?? 0) > 0 ? 'true' : undefined}>
                  <FieldLabel htmlFor={versionFieldId}>Pinned document version</FieldLabel>
                  {versions.isPending ? (
                    <Skeleton className="h-9 w-full" />
                  ) : (
                    <Select
                      value={binding.pinnedVersionNumber != null ? String(binding.pinnedVersionNumber) : FOLLOWS_TEMPLATE}
                      onValueChange={(next) => onConfigChange(withDocumentVersion(config, next === FOLLOWS_TEMPLATE ? null : Number(next)))}
                    >
                      <SelectTrigger id={versionFieldId}>
                        <SelectValue placeholder="Follows the template" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={FOLLOWS_TEMPLATE}>
                          Follows the template{templatePin != null ? ` (currently v${templatePin})` : ''}
                        </SelectItem>
                        {(versions.data ?? []).map((row) => (
                          <SelectItem key={row.versionNumber} value={String(row.versionNumber)}>
                            v{row.versionNumber}
                            {row.versionNumber === templatePin ? ' — served by the template' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <PinStatus state={state} pinned={binding.pinnedVersionNumber} templatePin={templatePin} />
                  <FieldError errors={versionErrors?.map((message) => ({ message }))} />
                </Field>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </FieldSet>
  );
}
