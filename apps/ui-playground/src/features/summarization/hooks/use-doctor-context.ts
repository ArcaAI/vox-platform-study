import { useMemo } from 'react';
import { useAuth } from '@arcaai/vox';
import { useAuthStore } from '@/store/auth-store';

const ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'] as const;
const DOCTOR_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'] as const;

export interface DoctorContext {
  effectiveUserId: string;
  isImpersonated: boolean;
  requiresImpersonation: boolean;
  isAdmin: boolean;
  isDoctor: boolean;
  primaryDepartmentId: string | undefined;
  roles: string[];
}

export function useDoctorContext(): DoctorContext {
  const localUser = useAuthStore((s) => s.user);
  const persistedImpersonating = useAuthStore((s) => s.isImpersonating);
  const persistedImpersonatedUser = useAuthStore((s) => s.impersonatedUser);
  const sdkAuth = useAuth();

  return useMemo(() => {
    const roles = localUser?.roles ?? [];
    const isAdmin = roles.some((r) => (ADMIN_ROLES as readonly string[]).includes(r));
    const isDoctor = roles.some((r) => (DOCTOR_ROLES as readonly string[]).includes(r));

    const isImpersonating = sdkAuth.isImpersonating || persistedImpersonating;
    const impersonatedUser = sdkAuth.impersonatedUser ?? persistedImpersonatedUser ?? null;

    const requiresImpersonation = isAdmin && !isDoctor && !isImpersonating;

    let effectiveUserId = localUser?.id ?? '';
    let primaryDepartmentId: string | undefined;
    let isImpersonated = false;

    if (isImpersonating && impersonatedUser) {
      effectiveUserId = impersonatedUser.id;
      isImpersonated = true;
      primaryDepartmentId = (impersonatedUser as unknown as Record<string, unknown>).primaryDepartmentId as string | undefined;
    } else if (localUser) {
      effectiveUserId = localUser.id;
      primaryDepartmentId = (localUser as unknown as Record<string, unknown>).primaryDepartmentId as string | undefined;
    }

    return {
      effectiveUserId,
      isImpersonated,
      requiresImpersonation,
      isAdmin,
      isDoctor,
      primaryDepartmentId,
      roles,
    };
  }, [localUser, sdkAuth.isImpersonating, sdkAuth.impersonatedUser, persistedImpersonating, persistedImpersonatedUser]);
}
