import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@arcaai/ui/alert-dialog';
import { Button } from '@arcaai/ui/button';
import { Loader2, AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'default' | 'destructive';
    onConfirm: () => void;
    isLoading?: boolean;
}

export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'default',
    onConfirm,
    isLoading,
}: ConfirmDialogProps) {
    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    {variant === 'destructive' && (
                        <div className="bg-destructive/10 mx-auto mb-2 flex size-10 items-center justify-center rounded-full">
                            <AlertTriangle className="text-destructive size-5" />
                        </div>
                    )}
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription>{description}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={isLoading}
                        onClick={() => onOpenChange(false)}
                    >
                        {cancelLabel}
                    </Button>
                    <Button
                        type="button"
                        disabled={isLoading}
                        onClick={onConfirm}
                        variant={variant === 'destructive' ? 'destructive' : 'default'}
                    >
                        {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
                        {confirmLabel}
                    </Button>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
