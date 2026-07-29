'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { useSignalWorkflow } from '../api';

type ParsedPayload = { ok: true; value: Record<string, unknown> | undefined } | { ok: false; message: string };

/** The gateway DTO validates `payload` with @IsObject — arrays/scalars reject. */
function parsePayload(text: string): ParsedPayload {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: undefined };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'Payload must be a JSON object (e.g. {"approved": true}).' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, message: `Invalid JSON: ${error instanceof Error ? error.message : 'parse failed'}` };
  }
}

/**
 * Frame 38 signal dialog: signal name + optional JSON payload (validated
 * client-side before POST workflows/:id/signal).
 */
export function SignalDialog({
  workflowId,
  open,
  onOpenChange,
}: {
  workflowId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const signal = useSignalWorkflow();
  const [signalName, setSignalName] = useState('');
  const [payloadText, setPayloadText] = useState('');
  const [payloadError, setPayloadError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setSignalName('');
      setPayloadText('');
      setPayloadError(null);
      signal.reset();
    }
    onOpenChange(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workflowId) return;
    const parsed = parsePayload(payloadText);
    if (!parsed.ok) {
      setPayloadError(parsed.message);
      return;
    }
    setPayloadError(null);
    const name = signalName.trim();
    signal.mutate(
      { workflowId, body: { signalName: name, ...(parsed.value !== undefined ? { payload: parsed.value } : {}) } },
      {
        onSuccess: () => {
          toast.success(`Signal "${name}" sent to ${workflowId}`);
          handleOpenChange(false);
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not signal the workflow.'),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Signal workflow</DialogTitle>
          <DialogDescription>
            Delivers a Temporal signal to <span className="font-mono">{workflowId}</span>. The optional payload is forwarded as the signal argument.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="signal-name">
              Signal name
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id="signal-name"
              value={signalName}
              onChange={(event) => setSignalName(event.target.value)}
              placeholder="approve"
              className="font-mono"
              maxLength={200}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="signal-payload">JSON payload (optional)</Label>
            <Textarea
              id="signal-payload"
              value={payloadText}
              onChange={(event) => {
                setPayloadText(event.target.value);
                if (payloadError) setPayloadError(null);
              }}
              placeholder={'{"approved": true}'}
              className="min-h-28 resize-none font-mono text-xs"
              aria-invalid={payloadError ? true : undefined}
            />
            {payloadError ? <p className="text-destructive text-sm">{payloadError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={signal.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!signalName.trim() || signal.isPending}>
              {signal.isPending ? <Spinner /> : null}
              Send signal
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
