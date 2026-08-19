'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { IconAlertTriangle, IconCircleCheck, IconLock } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { BreakGlassDialog, type BreakGlassCredentials } from '@/shared/confirm/break-glass-dialog';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { CopyButton } from '@/shared/copy-button';
import { cx } from '@/shared/cx';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useCreatePolicy, usePolicy, useUpdatePolicy, useValidatePolicyRules } from '../api/hooks';
import type { Policy, PolicyRule, PolicyScope, UpdatePolicyRequest } from '../api/types';

/** Starter rule so the editor never opens on an empty array. */
const RULES_TEMPLATE: PolicyRule[] = [{ action: 'read', subject: 'Consultation' }];

const SCOPE_CHOICES: Array<{ value: PolicyScope; label: string }> = [
  { value: 'TENANT', label: 'Tenant' },
  { value: 'GLOBAL', label: 'Global' },
];

function parseRules(text: string): { ok: true; rules: PolicyRule[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not parse the JSON.' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'Rules must be a JSON array of rule objects.' };
  }
  return { ok: true, rules: parsed as PolicyRule[] };
}

function Field({
  id,
  label,
  required,
  className,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden className="text-destructive">
            *
          </span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

/** Skeleton mirroring the form layout while the edited row loads (rule 10). */
function PolicyFormSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}

/**
 * Which row the local field state was seeded from. `updatedAt` is part of the
 * key on purpose: reloading after a 412 must reseed the editor from the server
 * row (what the retired `key={`${id}-${updatedAt}`}` remount did) — unlike the
 * model form, whose OCC alert promises to keep local edits.
 */
function seedKeyOf(open: boolean, isEdit: boolean, policy: Policy | null): string {
  if (!open) return 'closed';
  if (!isEdit) return 'create';
  return policy ? `row:${policy.id}:${policy.updatedAt}` : 'pending';
}

/**
 * Create/edit drawer (frame 22) in the console-wide DetailDrawer: the JSON
 * rules editor scrolls in the body, the actions stay pinned in the footer
 * (submit reaches the form through `form={formId}`). Validate runs a
 * client-side JSON.parse preflight, then POST /admin/rbac/policies/validate;
 * save stays disabled until the last validation passed on the CURRENT text
 * (re-edit -> revalidate). Edits that leave the rules untouched skip both the
 * validation gate and the rules field in the PATCH, so a rename never trips
 * the multi-role break-glass. A 428 on save opens the break-glass dialog and
 * retries with body.breakGlass; a 412 renders the OCC alert. Closing with
 * unsaved edits asks before discarding them.
 */
export function PolicyFormSheet({
  open,
  onOpenChange,
  policyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create mode. */
  policyId: string | null;
}) {
  const uid = useId();
  const formId = `${uid}-form`;
  const isEdit = policyId !== null;
  const detail = usePolicy(policyId ?? '');
  const policy = detail.data ?? null;

  const validateRules = useValidatePolicyRules();
  const createPolicy = useCreatePolicy();
  const updatePolicy = useUpdatePolicy();
  const isPending = createPolicy.isPending || updatePolicy.isPending;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<PolicyScope>('TENANT');
  const [rulesText, setRulesText] = useState('');
  const [baselineRulesText, setBaselineRulesText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  /** The exact editor text the last completed gateway validation ran against. */
  const [validatedText, setValidatedText] = useState<string | null>(null);
  const [breakGlassOpen, setBreakGlassOpen] = useState(false);
  const [breakGlassError, setBreakGlassError] = useState<string | null>(null);
  const [seededFor, setSeededFor] = useState<string>('closed');
  const [discarding, setDiscarding] = useState(false);

  // Seed during render (never in an effect): the fields must already hold the
  // loaded row on the commit that first shows them.
  const seedKey = seedKeyOf(open, isEdit, policy);
  if (seedKey !== seededFor) {
    const seeded = seedKey.startsWith('row:') && policy ? policy : undefined;
    const seededRules = JSON.stringify(seeded?.rules ?? RULES_TEMPLATE, null, 2);
    setSeededFor(seedKey);
    setName(seeded?.name ?? '');
    setDescription(seeded?.description ?? '');
    setScope(seeded?.scope ?? 'TENANT');
    setRulesText(seededRules);
    setBaselineRulesText(seededRules);
    setParseError(null);
    setValidatedText(null);
    setBreakGlassOpen(false);
    setBreakGlassError(null);
  }

  const showForm = !isEdit || (!detail.isPending && !detail.error && policy !== null);
  const validation = validatedText === rulesText && !parseError ? validateRules.data : undefined;
  const rulesValidated = validation?.valid === true;
  const rulesChanged = !isEdit || rulesText !== baselineRulesText;
  const isProtected = policy?.isProtected === true;
  const canSave = Boolean(name.trim()) && !isProtected && (!rulesChanged || rulesValidated);
  const occError = updatePolicy.error instanceof GatewayError && updatePolicy.error.isVersionConflict ? updatePolicy.error : null;
  const isDirty =
    name !== (policy && isEdit ? (policy.name ?? '') : '') ||
    description !== (policy && isEdit ? (policy.description ?? '') : '') ||
    scope !== (policy && isEdit ? policy.scope : 'TENANT') ||
    rulesText !== baselineRulesText;

  /** Closes for real and drops mutation state so a reopen starts clean. */
  function close() {
    setDiscarding(false);
    validateRules.reset();
    createPolicy.reset();
    updatePolicy.reset();
    onOpenChange(false);
  }

  /** Esc / overlay / Cancel — never discards unsaved edits without asking. */
  function handleOpenChange(next: boolean) {
    if (next) {
      onOpenChange(true);
      return;
    }
    // Blocked while a mutation is in flight. The DetailDrawer is told WHY via
    // `closeBlockedReason`, so the close control is properly disabled and named
    // rather than staying focusable and silently doing nothing (WCAG 4.1.2).
    if (isPending) return;
    if (isDirty) {
      setDiscarding(true);
      return;
    }
    close();
  }

  function handleValidate() {
    const parsed = parseRules(rulesText);
    if (!parsed.ok) {
      setParseError(parsed.error);
      setValidatedText(null);
      validateRules.reset();
      return;
    }
    setParseError(null);
    const text = rulesText;
    validateRules.mutate(parsed.rules, {
      onSuccess: () => setValidatedText(text),
      onError: (error) => toast.error(error.message),
    });
  }

  function buildUpdateBody(): UpdatePolicyRequest {
    return {
      name: name.trim(),
      description: description.trim() || undefined,
      scope,
      // Untouched rules stay out of the PATCH: the gateway only demands
      // break-glass when `rules` is present on a multi-role policy.
      ...(rulesChanged ? { rules: (parseRules(rulesText) as { ok: true; rules: PolicyRule[] }).rules } : {}),
    };
  }

  function submitUpdate(breakGlass?: BreakGlassCredentials) {
    if (!policy) return;
    updatePolicy.mutate(
      { id: policy.id, body: { ...buildUpdateBody(), ...(breakGlass ? { breakGlass } : {}) } },
      {
        onSuccess: () => {
          toast.success('Policy updated');
          setBreakGlassOpen(false);
          setBreakGlassError(null);
          close();
        },
        onError: (error) => {
          if (breakGlass) {
            // Wrong password (401) / name mismatch (400) / protected
            // (403) — shown inside the dialog for another attempt.
            setBreakGlassError(error.message);
            return;
          }
          if (error instanceof GatewayError && error.isMissingPrecondition) {
            // 428 — rule edits of a multi-role policy demand the
            // break-glass step-up; collect credentials and retry.
            setBreakGlassOpen(true);
            return;
          }
          if (error instanceof GatewayError && error.isVersionConflict) return; // inline OCC alert
          toast.error(error.message);
        },
      },
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    if (isEdit) {
      submitUpdate();
      return;
    }
    createPolicy.mutate(
      {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        scope,
        rules: (parseRules(rulesText) as { ok: true; rules: PolicyRule[] }).rules,
      },
      {
        onSuccess: () => {
          toast.success('Policy created');
          close();
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  return (
    <>
      <DetailDrawer
        closeBlockedReason={isPending ? 'Saving the policy — wait for it to finish.' : undefined}
        open={open}
        onOpenChange={handleOpenChange}
        title={isEdit ? 'Edit policy' : 'New policy'}
        meta={
          <>
            <span>
              {isEdit
                ? 'Rule edits are validated before save; multi-role policies require break-glass.'
                : 'Rules follow the CASL action/subject grammar and are validated before save.'}
            </span>
            {isEdit && policy ? (
              <>
                <span className="font-mono">{policy.id}</span>
                <CopyButton value={policy.id} label="Copy policy id" />
              </>
            ) : null}
          </>
        }
        footer={
          showForm ? (
            <div className="flex w-full flex-col gap-2">
              <OccConflictAlert
                error={occError}
                onReload={() => {
                  updatePolicy.reset();
                  void detail.refetch();
                }}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
                  Cancel
                </Button>
                <Button type="submit" form={formId} disabled={!canSave || isPending}>
                  {isPending ? <Spinner /> : null}
                  {isEdit ? 'Save changes' : 'Create policy'}
                </Button>
              </div>
            </div>
          ) : null
        }
      >
        {!open ? null : isEdit && detail.isPending ? (
          <PolicyFormSkeleton />
        ) : isEdit && !showForm ? (
          <ErrorState
            error={detail.error ?? new GatewayError(404, 'This policy does not exist or is outside your access scope.')}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-4">
            {isProtected ? (
              <Alert>
                <IconLock aria-hidden />
                <AlertTitle>Protected system policy</AlertTitle>
                <AlertDescription>Seed-managed anti-lockout policy — the gateway refuses every mutation.</AlertDescription>
              </Alert>
            ) : null}
            <Field id={`${uid}-name`} label="Name" required>
              <Input
                id={`${uid}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="consultation.read"
                autoComplete="off"
                className="font-mono"
                required
              />
            </Field>
            <Field id={`${uid}-description`} label="Description">
              <Input
                id={`${uid}-description`}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What this policy grants"
                autoComplete="off"
              />
            </Field>
            <Field id={`${uid}-scope`} label="Scope" required>
              <Select value={scope} onValueChange={(next) => setScope(next as PolicyScope)}>
                <SelectTrigger id={`${uid}-scope`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPE_CHOICES.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id={`${uid}-rules`} label="Rules (JSON)" required className="min-h-0 flex-1">
              <Textarea
                id={`${uid}-rules`}
                value={rulesText}
                onChange={(event) => setRulesText(event.target.value)}
                spellCheck={false}
                className="min-h-48 flex-1 resize-none font-mono text-xs"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={handleValidate} disabled={validateRules.isPending}>
                {validateRules.isPending ? <Spinner /> : null}
                Validate
              </Button>
              {rulesChanged && !rulesValidated && !parseError ? (
                <span className="text-muted-foreground text-xs">Validate the rules to enable save.</span>
              ) : null}
            </div>
            {parseError ? (
              <Alert variant="destructive">
                <IconAlertTriangle aria-hidden />
                <AlertTitle>Invalid JSON</AlertTitle>
                <AlertDescription>{parseError}</AlertDescription>
              </Alert>
            ) : null}
            {validation ? (
              validation.valid ? (
                <Alert>
                  <IconCircleCheck aria-hidden />
                  <AlertTitle>Rules are valid</AlertTitle>
                  {validation.warnings?.length ? (
                    <AlertDescription>
                      <ul className="list-disc pl-4">
                        {validation.warnings.map((warning) => (
                          <li key={warning}>{warning}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  ) : null}
                </Alert>
              ) : (
                <Alert variant="destructive">
                  <IconAlertTriangle aria-hidden />
                  <AlertTitle>Validation failed</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {(validation.errors ?? []).map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                      {(validation.warnings ?? []).map((warning) => (
                        <li key={warning} className="text-muted-foreground">
                          {warning}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )
            ) : null}
          </form>
        )}
      </DetailDrawer>
      {isEdit && policy ? (
        <BreakGlassDialog
          open={breakGlassOpen}
          onOpenChange={(next) => {
            if (!next) {
              setBreakGlassOpen(false);
              setBreakGlassError(null);
              updatePolicy.reset();
            }
          }}
          title="Confirm rule change"
          description={
            <>
              <span className="font-mono">{policy.name}</span> is attached to multiple roles, so editing its rules changes authorization for all of
              them at once. Confirm with your password and the exact policy name.
            </>
          }
          confirmationName={policy.name}
          confirmLabel="Save with break-glass"
          onConfirm={(credentials) => submitUpdate(credentials)}
          isPending={updatePolicy.isPending}
          error={breakGlassError}
        />
      ) : null}
      <ConfirmDialog
        open={discarding}
        onOpenChange={(next) => setDiscarding(next)}
        title="Discard unsaved changes?"
        description="This drawer has edits that have not been saved. Closing it discards them."
        confirmLabel="Discard changes"
        destructive
        onConfirm={close}
      />
    </>
  );
}
