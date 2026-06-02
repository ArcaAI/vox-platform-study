import { LiveCodePanel } from '@/components/live-code-panel';
import { Main } from '@/components/layout/main';
import { ImpersonationGuard } from '@/features/summarization/components/impersonation-guard';
import { useDoctorContext } from '@/features/summarization/hooks/use-doctor-context';
import { buildConsultationSnippet } from '@/lib/playground-snippets';
import { useAuthStore } from '@/store/auth-store';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Link } from '@tanstack/react-router';
import { Building2, UserCheck, UserCog } from 'lucide-react';
import { useMemo } from 'react';
import { ConsultationWorkspace } from './components/consultation-workspace';

export default function ConsultationPage() {
  const tenantId = useAuthStore((s) => s.tenantId);
  const hasTenant = !!tenantId;
  const { requiresImpersonation, isImpersonated, roles } = useDoctorContext();

  const canAccess = hasTenant && !requiresImpersonation;
  const consultationCode = useMemo(() => buildConsultationSnippet({ tenantId }), [tenantId]);

  return (
    <Main>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          {/* Header — always visible */}
          <div className="mb-6 flex items-center justify-between" data-doc="consultation-overview">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Consultations</h1>
              <p className="text-muted-foreground">Manage and explore consultation sessions.</p>
            </div>
            {canAccess && isImpersonated && (
              <Badge variant="secondary" className="gap-1.5" data-doc="consultation-impersonation-badge">
                <UserCheck className="size-3" />
                Impersonating
              </Badge>
            )}
          </div>

          {/* Guard: no tenant */}
          {!hasTenant ? (
            <div data-doc="consultation-tenant-required">
              <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
                      <Building2 className="size-5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Tenant Required</CardTitle>
                      <CardDescription>Select a tenant to access consultation features</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-muted-foreground text-sm">
                    Consultations are scoped to a specific tenant. Please select a tenant from the Playground Overview or impersonate a user that
                    belongs to a tenant.
                  </p>
                  <div className="flex items-center gap-3">
                    <Link to="/playground/overview">
                      <Button variant="default" size="sm" className="gap-2">
                        <UserCog className="size-4" />
                        Go to User Impersonation
                      </Button>
                    </Link>
                    <Badge variant="outline" className="text-xs">
                      Playground Overview &rarr; User Impersonation
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : /* Guard: impersonation required */
          requiresImpersonation ? (
            <ImpersonationGuard
              roles={roles}
              featureName="consultation"
              featureDescription="Consultations are doctor-scoped and require impersonation to view and manage."
            />
          ) : (
            /* Content: full access */
            <div data-doc="consultation-workspace">
              <ConsultationWorkspace />
              <LiveCodePanel className="mt-6" code={consultationCode} title="Consultation — SDK sample" filename="consultation-context.tsx" />
            </div>
          )}
        </div>
      </div>
    </Main>
  );
}
