/**
 * LaunchPanel (TASK-330 P3).
 *
 * Opens (get-or-creates) a consultation via `POST /consultations/open`. As of
 * TASK-356 Phase 5 the harness-vs-legacy routing is resolved SERVER-side from the
 * realtime PipelinePolicy cascade (the demo tenant carries a `harnessEnabled`
 * TENANT-scope row), so the client no longer hard-codes
 * `metadata.pipelineConfig.harnessEnabled`. Pre-fills the demo patient; the
 * impersonated doctor + tenant come from the active (impersonated) session.
 */
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { useArca } from '@arcaai/vox';
import { FlaskConical, Loader2, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DEMO } from '../constants';

function todayISO(): string {
  return new Date().toISOString().split('T')[0]!;
}

interface LaunchPanelProps {
  onOpened: (consultationId: string) => void;
}

export function LaunchPanel({ onOpened }: LaunchPanelProps) {
  const { session } = useArca();
  const [patientId, setPatientId] = useState<string>(DEMO.patientId);
  const [appointmentDate, setAppointmentDate] = useState<string>(todayISO);
  const [loading, setLoading] = useState(false);

  const handleOpen = async () => {
    const trimmed = patientId.trim();
    if (!trimmed) {
      toast.error('Patient ID is required');
      return;
    }
    setLoading(true);
    try {
      const consultation = await session.open({
        patientId: trimmed,
        appointmentDate: appointmentDate || todayISO(),
      });
      toast.success('Consultation opened');
      onOpened(consultation.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to open consultation');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 flex size-10 items-center justify-center rounded-full">
            <Stethoscope className="text-primary size-5" />
          </div>
          <div>
            <CardTitle className="text-base">Start a clinical visit</CardTitle>
            <CardDescription>Open a consultation to begin the ambient-scribe cockpit.</CardDescription>
          </div>
          <Badge variant="secondary" className="ml-auto gap-1">
            <FlaskConical className="size-3.5" />
            Harness
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="cw-patient">Patient ID</Label>
          <Input id="cw-patient" value={patientId} onChange={(e) => setPatientId(e.target.value)} placeholder={DEMO.patientId} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="cw-date">Appointment date</Label>
          <Input id="cw-date" type="date" value={appointmentDate} onChange={(e) => setAppointmentDate(e.target.value)} />
        </div>
        <Button onClick={() => void handleOpen()} disabled={loading} className="w-full" data-testid="launch-open">
          {loading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Stethoscope className="mr-1.5 size-4" />}
          Open consultation
        </Button>
        <p className="text-muted-foreground text-xs">
          Demo identities — tenant <code className="font-mono">{DEMO.tenantId.slice(0, 8)}…</code>, doctor{' '}
          <code className="font-mono">{DEMO.doctorId.slice(0, 8)}…</code>. The visit is routed through the clinical-documentation harness so the SOAP
          draft + provenance are generated on stop.
        </p>
      </CardContent>
    </Card>
  );
}
