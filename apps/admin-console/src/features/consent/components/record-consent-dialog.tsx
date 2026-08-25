'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { useCreateConsentGrant } from '../api';
import { CONSENT_GRANT_METHODS, CONSENT_PURPOSES, GRANT_METHOD_META, PURPOSE_META } from '../api';
import type { ConsentGrantMethod, ConsentPurpose } from '../api';

export interface RecordConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled and locked when the caller already knows the patient (point of care). */
  patientId?: string;
  /** Pre-selected purpose — the one the blocked action needs. */
  defaultPurpose?: ConsentPurpose;
  onRecorded?: () => void;
}

/**
 * Records a `ConsentGrant` (TASK-805).
 *
 * The attestation line is not decoration. This dialog is the only place a
 * human asserts that a patient authorized a use of their data — the gateway
 * refuses to let a machine identity make that claim at all
 * (`@ForbidServiceAccount` on `ConsentGrantController`, owner decision D-3) —
 * so the operator must see what they are attesting to before they can submit.
 */
export function RecordConsentDialog({ open, onOpenChange, patientId, defaultPurpose, onRecorded }: RecordConsentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open ? (
          <RecordConsentForm
            // Remount on identity change so field state initializes from props
            // once, with no setState-in-effect.
            key={`${patientId ?? ''}:${defaultPurpose ?? ''}`}
            patientId={patientId}
            defaultPurpose={defaultPurpose}
            onCancel={() => onOpenChange(false)}
            onDone={() => {
              onOpenChange(false);
              onRecorded?.();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RecordConsentForm({
  patientId,
  defaultPurpose,
  onCancel,
  onDone,
}: {
  patientId?: string;
  defaultPurpose?: ConsentPurpose;
  onCancel: () => void;
  onDone: () => void;
}) {
  const uid = useId();
  const createMutation = useCreateConsentGrant();

  const patientLocked = Boolean(patientId);
  const [externalPatientId, setExternalPatientId] = useState(patientId ?? '');
  const [purpose, setPurpose] = useState<ConsentPurpose>(defaultPurpose ?? 'AI_DOCUMENTATION');
  const [grantMethod, setGrantMethod] = useState<ConsentGrantMethod>('VERBAL_ATTESTED');
  const [expiresAt, setExpiresAt] = useState('');
  const [evidenceRef, setEvidenceRef] = useState('');
  const [attested, setAttested] = useState(false);
  const [patientError, setPatientError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = externalPatientId.trim();
    if (!trimmed) {
      setPatientError('Patient ID is required.');
      return;
    }
    setPatientError(null);

    createMutation.mutate(
      {
        externalPatientId: trimmed,
        purpose,
        grantMethod,
        // `datetime-local` yields a local wall-clock string; the DTO validates
        // `IsDateString`, so send a real ISO instant.
        ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        ...(evidenceRef.trim() ? { evidenceRef: evidenceRef.trim() } : {}),
      },
      {
        onSuccess: () => {
          toast.success(`Consent recorded — ${PURPOSE_META[purpose].label}`);
          onDone();
        },
        onError: (error) => {
          // A duplicate ACTIVE grant is refused by the DB's partial unique
          // index. That is a benign race (someone else recorded it, or the
          // operator double-submitted), not a failure the operator must fix.
          if (error instanceof GatewayError && error.status === 409) {
            toast.success('Consent for this purpose is already on record');
            onDone();
            return;
          }
          toast.error(error.message);
        },
      },
    );
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Record patient consent</DialogTitle>
        <DialogDescription>
          Creates an auditable consent grant. It takes effect immediately and is written to the tamper-evident consent ledger.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-patient`}>
          Patient ID{' '}
          <span aria-hidden className="text-destructive">
            *
          </span>
        </Label>
        <Input
          id={`${uid}-patient`}
          value={externalPatientId}
          onChange={(event) => setExternalPatientId(event.target.value)}
          readOnly={patientLocked}
          aria-invalid={!!patientError}
          aria-describedby={patientError ? `${uid}-patient-error` : undefined}
          className={patientLocked ? 'bg-muted font-mono' : 'font-mono'}
          placeholder="e.g. EHR-A:12345"
        />
        {patientError ? (
          <p id={`${uid}-patient-error`} className="text-destructive text-sm">
            {patientError}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-purpose`}>
          Purpose of use{' '}
          <span aria-hidden className="text-destructive">
            *
          </span>
        </Label>
        <Select value={purpose} onValueChange={(next) => setPurpose(next as ConsentPurpose)}>
          <SelectTrigger id={`${uid}-purpose`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONSENT_PURPOSES.map((value) => (
              <SelectItem key={value} value={value}>
                {PURPOSE_META[value].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{PURPOSE_META[purpose].description}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-method`}>
          How was consent captured?{' '}
          <span aria-hidden className="text-destructive">
            *
          </span>
        </Label>
        <Select value={grantMethod} onValueChange={(next) => setGrantMethod(next as ConsentGrantMethod)}>
          <SelectTrigger id={`${uid}-method`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONSENT_GRANT_METHODS.map((value) => (
              <SelectItem key={value} value={value}>
                {GRANT_METHOD_META[value].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">{GRANT_METHOD_META[grantMethod].description}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-expires`}>Expires (optional)</Label>
          <Input id={`${uid}-expires`} type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          <p className="text-muted-foreground text-xs">Leave empty for consent with no end date.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${uid}-evidence`}>Evidence reference (optional)</Label>
          <Input
            id={`${uid}-evidence`}
            value={evidenceRef}
            onChange={(event) => setEvidenceRef(event.target.value)}
            placeholder="e.g. s3://consents/2026/abc.pdf"
          />
          <p className="text-muted-foreground text-xs">Pointer to a signed form, if one exists.</p>
        </div>
      </div>

      <label className="border-warning/40 bg-warning/10 flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={attested}
          onChange={(event) => setAttested(event.target.checked)}
          className="accent-primary mt-0.5 size-4 shrink-0"
        />
        <span>
          I confirm the patient gave this consent and that I am recording it accurately. This is stored as an auditable clinical record attributed to
          my user account.
        </span>
      </label>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={createMutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!attested || createMutation.isPending}>
          {createMutation.isPending ? <Spinner aria-hidden data-icon="inline-start" /> : null}
          Record consent
        </Button>
      </DialogFooter>
      {!attested ? <p className="text-muted-foreground -mt-2 text-right text-xs">Confirm the attestation above to enable recording.</p> : null}
    </form>
  );
}
