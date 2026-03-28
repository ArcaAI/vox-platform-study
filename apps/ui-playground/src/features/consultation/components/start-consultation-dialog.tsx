import { Button } from '@arcaai/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { useArca } from '@arcaai/vox';
import { usePlaygroundStore } from '@/store/playground-store';
import { Plus, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

interface StartConsultationDialogProps {
  onSuccess?: (consultationId: string) => void;
  compact?: boolean;
}

export function StartConsultationDialog({ onSuccess, compact }: StartConsultationDialogProps) {
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [patientId, setPatientId] = useState('');
  const [appointmentDate, setAppointmentDate] = useState(todayISO);
  const [error, setError] = useState('');
  const { session } = useArca();
  const setLastConsultation = usePlaygroundStore((s) => s.setLastConsultation);

  const resetForm = () => {
    setPatientId('');
    setAppointmentDate(todayISO());
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmed = patientId.trim();
    if (!trimmed) {
      setError('Patient ID is required');
      return;
    }
    if (trimmed.length > 100) {
      setError('Patient ID is too long (max 100 characters)');
      return;
    }

    setError('');
    setIsLoading(true);
    try {
      const consultation = await session.open({
        patientId: trimmed,
        appointmentDate: appointmentDate || todayISO(),
      });
      setLastConsultation(consultation.id);
      toast.success(`Consultation started for patient ${trimmed}`);
      setOpen(false);
      resetForm();
      onSuccess?.(consultation.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start consultation';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) resetForm();
    setOpen(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {compact ? (
          <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs">
            <Plus data-icon="inline-start" />
            Start
          </Button>
        ) : (
          <Button>
            <Plus data-icon="inline-start" />
            Start Consultation
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Start New Consultation</DialogTitle>
          <DialogDescription>Enter a patient ID to start or resume a consultation session.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="patientId">
              Patient ID <span className="text-destructive">*</span>
            </Label>
            <Input
              id="patientId"
              placeholder="e.g. patient-123"
              autoFocus
              value={patientId || ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPatientId(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? 'patientId-error' : undefined}
            />
            {error && (
              <p id="patientId-error" className="text-destructive text-sm" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="appointmentDate">Appointment Date</Label>
            <Input
              id="appointmentDate"
              type="date"
              value={appointmentDate}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAppointmentDate(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isLoading}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isLoading ? 'Starting...' : 'Start'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
