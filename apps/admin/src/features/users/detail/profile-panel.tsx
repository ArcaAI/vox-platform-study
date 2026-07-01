import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import type { User } from '@arcaai/vox';
import { deriveUserStatus, userTypeLabel } from '@/features/users/user-query';
import { formatDateTime } from '@/lib/utils';

const EM_DASH = '—';

/** A label/value field; TARGET fields pass `target` to render the em-dash + note. */
function Field({ label, value, target }: { label: string; value?: ReactNode; target?: boolean }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
            <span className="text-sm text-foreground">
                {value ?? <span className="text-muted-foreground">{EM_DASH}</span>}
                {target ? <span className="ml-1.5 text-[10px] font-medium text-warning">Target</span> : null}
            </span>
        </div>
    );
}

/**
 * 38u **Profile** tab. REAL: username · email · status · service-account type
 * (and the resolved role). The richer profile fields the design shows (full
 * name, specialty, credentials, preferred name, phone, bio, MFA, last login,
 * sessions) are not on the `User` record — drawn with an em-dash + `Target`
 * flag rather than fabricated.
 */
export function ProfilePanel({ user, roleNames, canManage, onEdit }: { user: User; roleNames: string[]; canManage: boolean; onEdit: () => void }) {
    const status = deriveUserStatus(user);
    const createdAt = typeof user.createdAt === 'string' ? user.createdAt : undefined;

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
            <Card className="p-5">
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-sm font-semibold">Profile details</h2>
                    {canManage ? (
                        <Button variant="ghost" size="sm" className="h-7 text-primary" onClick={onEdit}>
                            <Pencil className="size-3.5" />
                            Edit
                        </Button>
                    ) : null}
                </div>
                <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
                    <Field label="Full name" target />
                    <Field
                        label="Role"
                        value={roleNames.length ? <span className="inline-flex flex-wrap gap-1">{roleNames.map((r) => <StatusBadge key={r} label={r} colorRole="primary" />)}</span> : undefined}
                    />
                    <Field label="Email" value={user.email || undefined} />
                    <Field label="Specialty" target />
                    <Field label="Username" value={<span className="font-mono">@{user.username}</span>} />
                    <Field label="Type" value={userTypeLabel(user.isServiceAccount)} />
                    <Field label="Preferred name" target />
                    <Field label="Phone" target />
                </div>
                <div className="mt-5 border-t pt-4">
                    <Field label="About" target />
                </div>
            </Card>

            <Card className="h-fit p-5">
                <h2 className="mb-4 text-sm font-semibold">Account &amp; security</h2>
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Status</span>
                        <StatusBadge label={status.label} colorRole={status.colorRole} />
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Member since</span>
                        <span className="text-sm">{createdAt ? formatDateTime(createdAt) : <span className="text-muted-foreground">{EM_DASH}</span>}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Last login</span>
                        <span className="text-sm text-muted-foreground">
                            {EM_DASH} <span className="text-[10px] font-medium text-warning">Target</span>
                        </span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">MFA</span>
                        <span className="text-sm text-muted-foreground">
                            {EM_DASH} <span className="text-[10px] font-medium text-warning">Target</span>
                        </span>
                    </div>
                    <div className="border-t pt-4">
                        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Password</span>
                        {/* TARGET: no reset-password endpoint (email link / temp password). */}
                        <Button variant="outline" size="sm" className="mt-1.5 w-full justify-between" disabled title="Target · password reset ships later">
                            Reset password
                            <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">Target</span>
                        </Button>
                        <p className="mt-1.5 text-xs text-muted-foreground">Email a reset link (audited) or set a temporary password — not yet available.</p>
                    </div>
                </div>
            </Card>
        </div>
    );
}
