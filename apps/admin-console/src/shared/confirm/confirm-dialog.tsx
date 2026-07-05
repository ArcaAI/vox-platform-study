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
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';

export interface ConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: ReactNode;
    description: ReactNode;
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
    /** Destructive pattern (frame 05): red action; optional type-to-confirm. */
    destructive?: boolean;
    /** Exact string the user must type to arm the confirm button. */
    typeToConfirm?: string;
    isPending?: boolean;
}

/**
 * Confirmation dialog per frame 05: destructive actions always confirm; the
 * riskiest ones (tenant delete...) additionally require typing the resource
 * name. Focus management comes from the Radix AlertDialog primitive.
 */
export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel,
    onConfirm,
    destructive = false,
    typeToConfirm,
    isPending = false,
}: ConfirmDialogProps) {
    const [typed, setTyped] = useState('');
    const inputId = useId();
    const armed = !typeToConfirm || typed === typeToConfirm;

    function handleOpenChange(next: boolean) {
        if (!next) setTyped('');
        onOpenChange(next);
    }

    return (
        <AlertDialog open={open} onOpenChange={handleOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription>{description}</AlertDialogDescription>
                </AlertDialogHeader>
                {typeToConfirm ? (
                    <div className="flex flex-col gap-2">
                        <Label htmlFor={inputId}>
                            Type <span className="font-mono font-semibold">{typeToConfirm}</span> to confirm
                        </Label>
                        <Input id={inputId} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
                    </div>
                ) : null}
                <AlertDialogFooter>
                    <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
                    <Button
                        variant={destructive ? 'destructive' : 'default'}
                        disabled={!armed || isPending}
                        onClick={() => void onConfirm()}
                    >
                        {isPending ? <Spinner /> : null}
                        {confirmLabel}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
