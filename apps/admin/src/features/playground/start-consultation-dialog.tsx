import { Button } from '@arcaai/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { useState } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * TASK-408 — sandbox consultation starter (screen 50). Only reachable when the
 * current identity passes the doctor gate (`canStartSandboxConsultation`) —
 * the SDK `session.open` is a get-or-create keyed on patient + date, exactly
 * the legacy playground flow.
 */
export function StartConsultationDialog({
  open,
  onOpenChange,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (patientId: string, appointmentDate: string) => Promise<void>;
}) {
  const [patientId, setPatientId] = useState('');
  const [appointmentDate, setAppointmentDate] = useState(todayIso());
  const [busy, setBusy] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setPatientId('');
      setAppointmentDate(todayIso());
    }
    onOpenChange(next);
  };

  const valid = patientId.trim().length > 0 && appointmentDate.length > 0;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      await onStart(patientId.trim(), appointmentDate);
      setPatientId('');
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={cn('sm:max-w-sm', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader>
          <DialogTitle>Start consultation</DialogTitle>
          <DialogDescription>Opens (or resumes) a consultation for this patient and date — a get-or-create, never a duplicate.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="sandbox-patient">
              Patient ID <span className="text-destructive">*</span>
            </Label>
            <Input
              id="sandbox-patient"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              placeholder="e.g. SANDBOX-001"
              maxLength={100}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="sandbox-date">
              Appointment date <span className="text-destructive">*</span>
            </Label>
            <Input id="sandbox-date" type="date" value={appointmentDate} onChange={(e) => setAppointmentDate(e.target.value)} />
          </div>
        </div>
        <DialogFooter className={MOBILE_DIALOG_FOOTER}>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? 'Opening…' : 'Start consultation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
