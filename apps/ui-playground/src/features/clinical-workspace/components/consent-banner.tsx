/**
 * ConsentBanner (TASK-330 P3, WS6 frontend slice).
 *
 * Plain-language consent gate shown before recording can start. Recording stays
 * disabled until the clinician confirms the patient was informed and consented.
 * Once recording is live it flips to a clear "recording — consent on file" state.
 */
import { Card, CardContent } from '@arcaai/ui/card';
import { Checkbox } from '@arcaai/ui/checkbox';
import { Label } from '@arcaai/ui/label';
import { Badge } from '@arcaai/ui/badge';
import { ShieldCheck, Mic } from 'lucide-react';

interface ConsentBannerProps {
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  recording: boolean;
}

export function ConsentBanner({ acknowledged, onAcknowledgedChange, recording }: ConsentBannerProps) {
  if (recording) {
    return (
      <Card className="border-emerald-500/40 bg-emerald-50/50 dark:bg-emerald-950/20" data-testid="consent-recording">
        <CardContent className="flex items-center gap-3 p-4">
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex size-2.5 rounded-full bg-red-600" />
          </span>
          <Mic className="size-4 text-emerald-700 dark:text-emerald-400" />
          <p className="text-sm">
            <span className="font-medium">Recording in progress.</span> The patient has been informed and consented to this visit being recorded and
            transcribed for documentation.
          </p>
          <Badge variant="outline" className="ml-auto gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-400">
            <ShieldCheck className="size-3.5" />
            Consent on file
          </Badge>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-amber-300/60 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20" data-testid="consent-banner">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <div className="bg-amber-100 dark:bg-amber-900/40 flex size-9 shrink-0 items-center justify-center rounded-full">
            <ShieldCheck className="size-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Patient consent to record</h3>
            <p className="text-muted-foreground text-sm">
              This visit will be recorded and transcribed in real time to draft clinical notes. Audio and the transcript are stored on the
              consultation. Please confirm you have informed the patient and obtained their consent before recording.
            </p>
          </div>
        </div>
        <Label className="flex items-center gap-2.5 pl-12 text-sm">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(checked) => onAcknowledgedChange(checked === true)}
            data-testid="consent-checkbox"
            aria-label="Confirm patient consent to record"
          />
          I have informed the patient and obtained consent to record this visit.
        </Label>
      </CardContent>
    </Card>
  );
}
