/**
 * ConfigConflictModal — TASK-302 Stream D Phase D.5 stub.
 *
 * Surfaces an optimistic-concurrency conflict ("someone else saved this
 * setting while you were editing it") so the admin can refresh and try
 * again. The stub deliberately omits a 3-way diff of "your draft |
 * current | their change at t=…"; that view requires the
 * `GlobalSettingHistory` row-version table (TASK-3XX) which is out of
 * scope here. Until that table lands the only safe affordance is
 * "Refresh and re-apply." When the table arrives, swap the
 * `DialogDescription` block for the diff renderer; no other change
 * needed.
 *
 * The modal is intentionally dismissable (per Code Review Gate D bullet)
 * so an admin who decides "actually I don't want to save anymore" can
 * close it and continue navigating. A blocking modal would hostage the
 * page and is not justified by the failure mode.
 */

import { Button } from '@arcaai/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@arcaai/ui/dialog';
import type { ConfigConflictError } from '@arcaai/vox';

export interface ConfigConflictModalProps {
    /**
     * The structured OCC error captured from `useGlobalSettings.update`
     * (or any caller that catches the SDK's `ConfigConflictError`). When
     * `null`, the modal renders nothing — this is the common-case prop
     * during the dismiss animation.
     */
    error: ConfigConflictError | null;
    /**
     * Called when the admin asks to refresh the row and retry. Typical
     * implementation: `await refetch(); setConflictErr(null);`. The
     * modal does not call `setConflictErr` itself — that's the parent's
     * job so the open/close transition can be coordinated with any
     * surrounding state (focus, pending mutation flags, etc.).
     */
    onRefresh: () => void;
    /**
     * Called when the admin dismisses without refreshing. The page
     * keeps the user's draft in the editor; the next save attempt will
     * race again. This is intentional — we are NOT silently discarding
     * the user's typing just because the server moved on.
     */
    onDismiss: () => void;
}

export function ConfigConflictModal({ error, onRefresh, onDismiss }: ConfigConflictModalProps) {
    if (!error) return null;

    // Radix `onOpenChange` fires with `false` when the user clicks the
    // overlay or hits Escape. We route both into `onDismiss` so the
    // parent's `conflictErr` state stays in sync with the Radix open
    // state — otherwise the dialog would re-open on the next render.
    const handleOpenChange = (open: boolean) => {
        if (!open) onDismiss();
    };

    return (
        <Dialog open onOpenChange={handleOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>This setting was changed by someone else</DialogTitle>
                    <DialogDescription>
                        You were editing version {error.expectedVersion}, but the current version is {error.currentVersion}. Refresh to see the latest value before re-applying your change.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={onDismiss}>
                        Cancel
                    </Button>
                    <Button onClick={onRefresh}>Refresh and try again</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
