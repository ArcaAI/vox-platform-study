'use client';

import { toast } from 'sonner';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { usePauseQueue, useResumeQueue } from '../api/hooks';
import { toastRequestError } from './toasts';

export type PauseResumeAction = 'pause' | 'resume';

const COPY: Record<PauseResumeAction, { title: (name: string) => string; description: string; confirmLabel: string; success: (name: string) => string }> = {
    pause: {
        title: (name) => `Pause queue ${name}?`,
        description: 'Workers stop picking up new jobs from this queue until it is resumed. Jobs already running finish normally.',
        confirmLabel: 'Pause queue',
        success: (name) => `Queue ${name} paused`,
    },
    resume: {
        title: (name) => `Resume queue ${name}?`,
        description: 'Workers start picking up waiting jobs from this queue again.',
        confirmLabel: 'Resume queue',
        success: (name) => `Queue ${name} resumed`,
    },
};

/** Pause/resume are reversible but disruptive — both confirm (frame 17 actions). */
export function PauseResumeDialog({
    queueName,
    action,
    open,
    onOpenChange,
}: {
    queueName: string;
    action: PauseResumeAction;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const pauseQueue = usePauseQueue();
    const resumeQueue = useResumeQueue();
    const mutation = action === 'pause' ? pauseQueue : resumeQueue;
    const copy = COPY[action];

    return (
        <ConfirmDialog
            open={open}
            onOpenChange={onOpenChange}
            title={copy.title(queueName)}
            description={copy.description}
            confirmLabel={copy.confirmLabel}
            isPending={mutation.isPending}
            onConfirm={() =>
                mutation.mutate(queueName, {
                    onSuccess: () => {
                        toast.success(copy.success(queueName));
                        onOpenChange(false);
                    },
                    onError: toastRequestError,
                })
            }
        />
    );
}
