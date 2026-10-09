'use client';

import { useId, useState, type ReactNode } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@arcaai/ui/components/shadcn/alert-dialog';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { ReasonField } from '@/shared/action-confirmations/reason-field';
import { useActionConfirmation } from '@/shared/action-confirmations/use-action-confirmation';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  /** Receives the reason typed into the policy-driven field (when `reasonActionId` is set). */
  onConfirm: (input: { reason?: string }) => void | Promise<void>;
  /**
   * Detail the confirmation needs but the one-line `description` cannot hold —
   * a consumer list, a diff, a warning block. Rendered between the description
   * and the arming controls.
   */
  body?: ReactNode;
  /**
   * Text of a checkbox the user must tick before the confirm button arms. The
   * label IS the visible reason the button is disabled (rule 11 §5), so it
   * states the consequence being accepted, not "I agree".
   */
  acknowledgement?: ReactNode;
  /** Destructive pattern (frame 05): red action; optional type-to-confirm. */
  destructive?: boolean;
  /** Exact string the user must type to arm the confirm button. */
  typeToConfirm?: string;
  /**
   * TASK-1057 — catalogue action id governing `typeToConfirm` (a `typeToConfirm` row). When the
   * platform switches that row to `not-required`, the typed name is not asked for.
   */
  typeToConfirmActionId?: string;
  /**
   * TASK-1057 — catalogue action id of a `reason` row: renders the shared reason field, arms the
   * button only once the policy is satisfied, and passes the text to `onConfirm`.
   */
  reasonActionId?: string;
  /** Evaluates a `when-risky` reason row. */
  reasonRisky?: boolean;
  isPending?: boolean;
}

/**
 * Confirmation dialog per frame 05: destructive actions always confirm; the
 * riskiest ones (tenant delete...) additionally require typing the resource
 * name. Focus management comes from the Radix AlertDialog primitive.
 *
 * `body` and `acknowledgement` exist so a consequential confirmation can lead
 * with the EFFECT — what will break, and for whom — and gate the action on the
 * admin reading it, instead of a bare "are you sure?".
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  body,
  acknowledgement,
  destructive = false,
  typeToConfirm: typeToConfirmProp,
  typeToConfirmActionId,
  reasonActionId,
  reasonRisky,
  isPending = false,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState('');
  const inputId = useId();
  const acknowledgeId = useId();
  // Hooks run unconditionally; an absent id resolves to a policy we never read.
  const typedPolicy = useActionConfirmation(typeToConfirmActionId ?? 'tenant.delete', { enabled: Boolean(typeToConfirmActionId) });
  const reasonPolicy = useActionConfirmation(reasonActionId ?? 'promptTemplate.update', { enabled: Boolean(reasonActionId) });
  const typeToConfirm = typeToConfirmActionId && !typedPolicy.isRequired() ? undefined : typeToConfirmProp;
  const reasonOk = !reasonActionId || reasonPolicy.isSatisfied(reason, reasonRisky);
  const armed = (!typeToConfirm || typed === typeToConfirm) && (!acknowledgement || acknowledged) && reasonOk;

  // Disarm on every open/close transition — adjusted DURING RENDER (React's
  // "adjusting state when a prop changes" pattern) rather than in the
  // `onOpenChange` handler, so a dialog closed by its OWNER (a successful
  // mutation setting `open={false}`, not a Cancel click) is re-armed from
  // scratch the next time it opens. Arming state that survives a close is how
  // a second, different confirmation inherits the first one's consent.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    setTyped('');
    setAcknowledged(false);
    setReason('');
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {body ? <div className="text-sm">{body}</div> : null}
        {acknowledgement ? (
          <div className="flex items-start gap-2 rounded-md border p-3">
            <Checkbox id={acknowledgeId} checked={acknowledged} onCheckedChange={(checked) => setAcknowledged(checked === true)} />
            <Label htmlFor={acknowledgeId} className="text-sm leading-snug font-normal">
              {acknowledgement}
            </Label>
          </div>
        ) : null}
        {reasonActionId ? <ReasonField actionId={reasonActionId} value={reason} onChange={setReason} risky={reasonRisky} disabled={isPending} /> : null}
        {typeToConfirm ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={inputId}>
              Type <span className="font-mono font-medium">{typeToConfirm}</span> to confirm
            </Label>
            <Input id={inputId} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={!armed || isPending} onClick={() => void onConfirm(reasonActionId && reason.trim() ? { reason: reason.trim() } : {})}>
            {isPending ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
