'use client';

import { useId, useState } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { CopyButton } from '@/shared/copy-button';

export interface RawKeyResult {
    rawKey: string;
    keyName: string;
    mode: 'created' | 'rotated';
}

/**
 * One-time raw-key dialog (frame 23): the secret from create/rotate is shown
 * exactly once — the caller clears it from state on close, so the dialog can
 * never be reopened. "Done" arms only after the "I stored it" confirmation
 * (matrix annotation), though any close path still forfeits the key.
 */
export function RawKeyDialog({ result, onClose }: { result: RawKeyResult | null; onClose: () => void }) {
    const checkboxId = useId();
    const [stored, setStored] = useState(false);

    function handleOpenChange(open: boolean) {
        if (!open) {
            setStored(false);
            onClose();
        }
    }

    return (
        <Dialog open={result !== null} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{result?.mode === 'rotated' ? 'API key rotated' : 'API key created'}</DialogTitle>
                    <DialogDescription>
                        Secret key for <span className="font-mono">{result?.keyName}</span>. It is shown exactly once.
                    </DialogDescription>
                </DialogHeader>
                <Alert>
                    <IconAlertTriangle aria-hidden />
                    <AlertTitle>Store it now &mdash; you won&rsquo;t see it again</AlertTitle>
                    <AlertDescription>The platform keeps only a hash. Closing this dialog discards the key for good.</AlertDescription>
                </Alert>
                <div className="bg-muted flex items-center gap-2 rounded-md p-3">
                    <code className="min-w-0 flex-1 font-mono text-sm break-all">{result?.rawKey}</code>
                    <CopyButton value={result?.rawKey ?? ''} label="Copy API key" />
                </div>
                <div className="flex items-center gap-2">
                    <Checkbox id={checkboxId} checked={stored} onCheckedChange={(checked) => setStored(checked === true)} />
                    <Label htmlFor={checkboxId} className="font-normal">
                        I stored this key securely
                    </Label>
                </div>
                <DialogFooter>
                    <Button disabled={!stored} onClick={() => handleOpenChange(false)}>
                        Done
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
