'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconKey, IconLock, IconRefresh } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { ErrorState } from '@/shared/state/error-state';
import { useSecurityPolicy, useUpdateSecurityPolicy } from '../api/hooks';
import type { SecretEncoding, SecurityPolicy, UpdateSecurityPolicyRequest } from '../api/types';

/** Password floor of 8 = NIST SP 800-63B for a user-chosen secret; the gateway DTO enforces the same. */
const PASSWORD_MIN_FLOOR = 8;
const PASSWORD_MIN_CEILING = 128;
const MAX_AGE_CEILING = 3650;

const CHARACTER_CLASSES = [
  { field: 'passwordRequireUppercase', policyKey: 'requireUppercase', label: 'Uppercase letter', hint: 'At least one A–Z' },
  { field: 'passwordRequireLowercase', policyKey: 'requireLowercase', label: 'Lowercase letter', hint: 'At least one a–z' },
  { field: 'passwordRequireDigit', policyKey: 'requireDigit', label: 'Digit', hint: 'At least one 0–9' },
  { field: 'passwordRequireSpecial', policyKey: 'requireSpecial', label: 'Special character', hint: 'At least one non-alphanumeric' },
] as const;

/** The editable projection of the policy — exactly the PUT body's field set. */
interface Draft {
  passwordMinLength: string;
  passwordRequireUppercase: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireDigit: boolean;
  passwordRequireSpecial: boolean;
  passwordMaxAgeDays: string;
  secretByteLength: string;
  secretEncoding: SecretEncoding;
}

function toDraft(policy: SecurityPolicy): Draft {
  return {
    passwordMinLength: String(policy.password.minLength),
    passwordRequireUppercase: policy.password.requireUppercase,
    passwordRequireLowercase: policy.password.requireLowercase,
    passwordRequireDigit: policy.password.requireDigit,
    passwordRequireSpecial: policy.password.requireSpecial,
    passwordMaxAgeDays: String(policy.password.maxAgeDays),
    secretByteLength: String(policy.secret.byteLength),
    secretEncoding: policy.secret.encoding,
  };
}

/**
 * Only the CHANGED fields are sent — the gateway write is partial and each
 * field is its own `GlobalSetting` row, so sending an unchanged value would
 * bump a row's version and emit a sys-event for a non-change.
 */
function diff(saved: Draft, draft: Draft): UpdateSecurityPolicyRequest {
  const body: UpdateSecurityPolicyRequest = {};
  if (draft.passwordMinLength !== saved.passwordMinLength) body.passwordMinLength = Number(draft.passwordMinLength);
  if (draft.passwordMaxAgeDays !== saved.passwordMaxAgeDays) body.passwordMaxAgeDays = Number(draft.passwordMaxAgeDays);
  if (draft.secretByteLength !== saved.secretByteLength) body.secretByteLength = Number(draft.secretByteLength);
  if (draft.secretEncoding !== saved.secretEncoding) body.secretEncoding = draft.secretEncoding;
  for (const { field } of CHARACTER_CLASSES) {
    if (draft[field] !== saved[field]) body[field] = draft[field];
  }
  return body;
}

function SecurityPolicySkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      {[0, 1].map((card) => (
        <div key={card} className="bg-card flex flex-col gap-4 rounded-md border p-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1, 2, 3].map((field) => (
              <div key={field} className="flex flex-col gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SecurityPolicyScreen() {
  const uid = useId();
  const query = useSecurityPolicy();
  const mutation = useUpdateSecurityPolicy();
  const [draft, setDraft] = useState<Draft | null>(null);

  if (query.isError) {
    return (
      <ScreenTemplate header={<PageHeader title="Credential policy" />}>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </ScreenTemplate>
    );
  }

  const policy = query.data;
  const saved = policy ? toDraft(policy) : null;
  const current = draft ?? saved;
  const body = saved && current ? diff(saved, current) : {};
  const dirty = Object.keys(body).length > 0;

  function set<K extends keyof Draft>(field: K, value: Draft[K]) {
    if (!current) return;
    setDraft({ ...current, [field]: value });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    mutation.mutate(body, {
      onSuccess: () => {
        toast.success('Credential policy saved');
        // Drop the draft so the re-read effective policy becomes the baseline —
        // the server may have clamped a value, and the server's answer wins.
        setDraft(null);
      },
      // The write is not transactional, so a failure may have applied some keys.
      // The hook invalidates on error; clearing the draft re-seeds from truth.
      onError: (error) => {
        toast.error(error.message);
        setDraft(null);
      },
    });
  }

  return (
    <ScreenTemplate
      header={
        <PageHeader
          title="Credential policy"
          meta={
            <>
              <span>Platform-wide. Applies to every tenant.</span>
              <Badge variant="outline" className="font-mono text-xs">
                security.password.* · security.secret.*
              </Badge>
            </>
          }
          actions={
            <>
              <Button type="button" variant="outline" disabled={!dirty || mutation.isPending} onClick={() => setDraft(null)}>
                <IconRefresh aria-hidden />
                Discard changes
              </Button>
              <Button type="submit" form={`${uid}-form`} disabled={!dirty || mutation.isPending}>
                {mutation.isPending ? <Spinner /> : null}
                Save policy
              </Button>
            </>
          }
        />
      }
      footer={
        <StatusFooter
          start={
            mutation.isPending
              ? 'Saving…'
              : dirty
                ? `${Object.keys(body).length} unsaved change${Object.keys(body).length === 1 ? '' : 's'}`
                : 'No unsaved changes'
          }
          end={
            policy ? (
              <span className="font-mono">
                secret entropy {policy.bounds.minByteLength}–{policy.bounds.maxByteLength} bytes
              </span>
            ) : null
          }
        />
      }
    >
      {!policy || !current ? (
        <SecurityPolicySkeleton />
      ) : (
        <form id={`${uid}-form`} onSubmit={handleSubmit} className="flex flex-col gap-6">
          <Card className="gap-4 p-4" aria-labelledby={`${uid}-password-title`}>
            <div className="flex flex-col gap-1">
              <h2 id={`${uid}-password-title`} className="flex items-center gap-2 text-sm font-medium">
                <IconLock className="size-4" aria-hidden />
                Passwords
              </h2>
              <p className="text-muted-foreground text-xs">
                Enforced on every path that sets a password — admin temporary password, self-service reset, registration.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${uid}-min-length`}>Minimum length</Label>
                <Input
                  id={`${uid}-min-length`}
                  type="number"
                  inputMode="numeric"
                  min={PASSWORD_MIN_FLOOR}
                  max={PASSWORD_MIN_CEILING}
                  required
                  value={current.passwordMinLength}
                  aria-describedby={`${uid}-min-length-hint`}
                  onChange={(event) => set('passwordMinLength', event.target.value)}
                />
                <p id={`${uid}-min-length-hint`} className="text-muted-foreground text-xs">
                  {PASSWORD_MIN_FLOOR}–{PASSWORD_MIN_CEILING} characters. Maximum length is fixed at {policy.password.maxLength} (a hashing bound, not
                  policy).
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${uid}-max-age`}>Rotation window (days)</Label>
                <Input
                  id={`${uid}-max-age`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_AGE_CEILING}
                  required
                  value={current.passwordMaxAgeDays}
                  aria-describedby={`${uid}-max-age-hint`}
                  onChange={(event) => set('passwordMaxAgeDays', event.target.value)}
                />
                <p id={`${uid}-max-age-hint`} className="text-muted-foreground text-xs">
                  0 disables rotation. When set, login warns and never blocks; users with no recorded change date are never expired.
                </p>
              </div>
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className="text-muted-foreground text-xs font-medium">Required character classes</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {CHARACTER_CLASSES.map(({ field, label, hint }) => (
                  <div key={field} className="flex items-start justify-between gap-3 rounded-md border p-3">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <Label htmlFor={`${uid}-${field}`} className="text-sm font-medium">
                        {label}
                      </Label>
                      <p className="text-muted-foreground text-xs">{hint}</p>
                    </div>
                    <Switch
                      id={`${uid}-${field}`}
                      checked={current[field]}
                      onCheckedChange={(checked) => set(field, checked)}
                      aria-describedby={`${uid}-password-title`}
                    />
                  </div>
                ))}
              </div>
            </fieldset>
          </Card>

          <Card className="gap-4 p-4" aria-labelledby={`${uid}-secret-title`}>
            <div className="flex flex-col gap-1">
              <h2 id={`${uid}-secret-title`} className="flex items-center gap-2 text-sm font-medium">
                <IconKey className="size-4" aria-hidden />
                Issued machine credentials
              </h2>
              <p className="text-muted-foreground text-xs">
                Applies to the NEXT issuance only — credentials already handed out keep working, so tightening this is a prompt to rotate, never a
                retroactive revocation.
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {policy.bounds.governedSurfaces.map((surface) => (
                  <Badge key={surface} variant="secondary" className="font-mono text-xs">
                    {surface}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${uid}-byte-length`}>Entropy (bytes)</Label>
                <Input
                  id={`${uid}-byte-length`}
                  type="number"
                  inputMode="numeric"
                  min={policy.bounds.minByteLength}
                  max={policy.bounds.maxByteLength}
                  required
                  value={current.secretByteLength}
                  aria-describedby={`${uid}-byte-length-hint`}
                  onChange={(event) => set('secretByteLength', event.target.value)}
                />
                <p id={`${uid}-byte-length-hint`} className="text-muted-foreground text-xs">
                  {policy.bounds.minByteLength}–{policy.bounds.maxByteLength} bytes of randomness ({policy.bounds.minByteLength * 8}–
                  {policy.bounds.maxByteLength * 8} bits) — not characters. The floor is enforced in code, so a lower value is raised rather than
                  accepted.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${uid}-encoding`}>Alphabet</Label>
                <Select value={current.secretEncoding} onValueChange={(value) => set('secretEncoding', value as SecretEncoding)}>
                  <SelectTrigger id={`${uid}-encoding`} className="w-full" aria-describedby={`${uid}-encoding-hint`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hex">hex — 4 bits per character</SelectItem>
                    <SelectItem value="base64url">base64url — 6 bits per character, ~33% shorter</SelectItem>
                  </SelectContent>
                </Select>
                <p id={`${uid}-encoding-hint`} className="text-muted-foreground text-xs">
                  Ignored where the credential format pins its own alphabet:{' '}
                  {Object.entries(policy.bounds.pinnedEncodings)
                    .map(([surface, encoding]) => `${surface} is always ${encoding}`)
                    .join(', ')}
                  .
                </p>
              </div>
            </div>
          </Card>
        </form>
      )}
    </ScreenTemplate>
  );
}
