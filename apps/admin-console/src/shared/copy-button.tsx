'use client';

import { IconCopy } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';

/** Icon-only copy control with an accessible name and toast feedback. */
export function CopyButton({ value, label }: { value: string; label: string }) {
    async function copy() {
        try {
            await navigator.clipboard.writeText(value);
            toast.success('Copied to clipboard');
        } catch {
            toast.error('Copy failed');
        }
    }

    return (
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={() => void copy()}>
            <IconCopy aria-hidden />
        </Button>
    );
}
