import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@arcaai/ui/alert-dialog';
import { Button } from '@arcaai/ui/button';
import { Spinner } from '@arcaai/ui/spinner';
import { useState, type ReactNode } from 'react';

/**
 * Shared destructive-confirmation dialog. Keeps the dialog open while the async
 * action runs (spinner), then closes on success. The confirm button is a plain
 * destructive Button (not AlertDialogAction) so we control the close timing.
 */
export function ConfirmDelete({
    trigger,
    title,
    description,
    confirmLabel = 'Delete',
    onConfirm,
}: {
    trigger: ReactNode;
    title: string;
    description: ReactNode;
    confirmLabel?: string;
    onConfirm: () => Promise<void> | void;
}) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    const handle = async () => {
        setBusy(true);
        try {
            await onConfirm();
            setOpen(false);
        } finally {
            setBusy(false);
        }
    };

    return (
        <AlertDialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
            <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription>{description}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <Button variant="destructive" onClick={() => void handle()} disabled={busy}>
                        {busy ? <Spinner className="size-4" /> : confirmLabel}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
