'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { ErrorState } from '@/shared/state/error-state';
import { useUpdateUserProfile, useUserProfile } from '../api/hooks';
import type { UpdateUserProfileRequest, UserProfile } from '../api/types';

function ProfileField({
    id,
    label,
    value,
    onChange,
    type = 'text',
    autoComplete = 'off',
}: {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    type?: string;
    autoComplete?: string;
}) {
    return (
        <div className="flex flex-col gap-2">
            <Label htmlFor={id}>{label}</Label>
            <Input id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} />
        </div>
    );
}

/**
 * The profile PATCH is an upsert (no If-Match on this route): a null read
 * renders an empty form whose first save creates the profile. Empty fields
 * are omitted from the body so untouched values are never cleared.
 */
function ProfileForm({ userId, profile }: { userId: string; profile: UserProfile | null }) {
    const updateProfile = useUpdateUserProfile();
    const [firstName, setFirstName] = useState(profile?.firstName ?? '');
    const [lastName, setLastName] = useState(profile?.lastName ?? '');
    const [email, setEmail] = useState(profile?.email ?? '');
    const [phone, setPhone] = useState(profile?.phone ?? '');

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const body: UpdateUserProfileRequest = {
            ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
            ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
            ...(email.trim() ? { email: email.trim() } : {}),
            ...(phone.trim() ? { phone: phone.trim() } : {}),
        };
        updateProfile.mutate(
            { id: userId, body },
            {
                onSuccess: () => toast.success('Profile saved'),
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not save the profile.'),
            },
        );
    }

    return (
        <Card className="p-6">
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                {profile ? null : <p className="text-muted-foreground text-sm">No profile yet — saving these details creates one.</p>}
                <div className="grid gap-4 sm:grid-cols-2">
                    <ProfileField id="profile-first-name" label="First name" value={firstName} onChange={setFirstName} autoComplete="given-name" />
                    <ProfileField id="profile-last-name" label="Last name" value={lastName} onChange={setLastName} autoComplete="family-name" />
                    <ProfileField id="profile-email" label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
                    <ProfileField id="profile-phone" label="Phone" type="tel" value={phone} onChange={setPhone} autoComplete="tel" />
                </div>
                <div className="flex justify-end">
                    <Button type="submit" disabled={updateProfile.isPending}>
                        {updateProfile.isPending ? <Spinner /> : null}
                        Save profile
                    </Button>
                </div>
            </form>
        </Card>
    );
}

/** Frame 20.1 profile tab: identity contact fields behind the admin upsert. */
export function UserProfileTab({ id }: { id: string }) {
    const { data, isLoading, error, refetch } = useUserProfile(id);

    if (isLoading) {
        return (
            <Card className="p-6">
                <div className="grid gap-4 sm:grid-cols-2">
                    {Array.from({ length: 4 }, (_, index) => (
                        <div key={index} className="flex flex-col gap-2">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-9 w-full" />
                        </div>
                    ))}
                </div>
            </Card>
        );
    }
    if (error) {
        return <ErrorState error={error} onRetry={() => refetch()} />;
    }

    // Remount the form when another admin's save refetches new values.
    return <ProfileForm key={data?.updatedAt ?? 'new'} userId={id} profile={data ?? null} />;
}
