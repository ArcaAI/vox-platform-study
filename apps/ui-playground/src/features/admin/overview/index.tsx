import { Link } from '@tanstack/react-router';
import { Main } from '@/components/layout/main';
import { useAuthStore } from '@/store/auth-store';
import { useTenants, useTenant } from '../api/tenants';
import { useAdminUsers } from '../api/users';
import { StatusBadge } from '../components';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Separator } from '@arcaai/ui/separator';
import { Skeleton } from '@arcaai/ui/skeleton';
import { ArrowRight, Building2, Calendar, Info, Shield, Users } from 'lucide-react';

function formatDate(date?: string | Date | null) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminOverviewPage() {
  const { user, tenantId, tenantName, isSuperAdmin } = useAuthStore();
  const isSuper = isSuperAdmin();

  const { data: currentTenant, isLoading: tenantLoading } = useTenant(tenantId || '', {
    enabled: !!tenantId,
  });

  const { data: tenantsData, isLoading: tenantsLoading } = useTenants({ page: 1, limit: 1 }, { enabled: isSuper });

  const { data: usersData, isLoading: usersLoading } = useAdminUsers({ page: 1, limit: 1 }, { enabled: isSuper });

  return (
    <Main>
      <div className="mb-6">
        <h2 className="text-2xl font-bold tracking-tight">Administration</h2>
        <p className="text-muted-foreground mt-1">Manage tenants, users, configurations, and system settings.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <Card className="md:col-span-2 lg:col-span-3">
          <CardHeader className="flex flex-row items-start gap-4">
            <div className="bg-primary/10 flex size-10 shrink-0 items-center justify-center rounded-lg">
              <Info className="text-primary size-5" />
            </div>
            <div className="space-y-1">
              <CardTitle className="text-base">Welcome to Administration</CardTitle>
              <CardDescription>
                This section provides tools for managing your platform. Impersonation is not applied here — all actions are performed as your real
                identity.
              </CardDescription>
            </div>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Shield className="text-muted-foreground size-4" />
              <CardTitle className="text-sm font-medium">Current User</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-sm font-medium">{user?.username || '—'}</p>
              <p className="text-muted-foreground text-xs">{user?.email || 'No email set'}</p>
            </div>
            <Separator />
            <div className="flex flex-wrap gap-1.5">
              {user?.roles?.length ? (
                user.roles.map((role: string) => (
                  <Badge key={role} variant="secondary" className="text-xs">
                    {role}
                  </Badge>
                ))
              ) : (
                <span className="text-muted-foreground text-xs">No roles assigned</span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Building2 className="text-muted-foreground size-4" />
              <CardTitle className="text-sm font-medium">Current Tenant</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {tenantLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
            ) : currentTenant ? (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{currentTenant.name}</p>
                    <p className="text-muted-foreground font-mono text-xs">{currentTenant.key}</p>
                  </div>
                  <StatusBadge status={currentTenant.resourceStatus || 'ENABLED'} />
                </div>
                {currentTenant.description && (
                  <>
                    <Separator />
                    <p className="text-muted-foreground text-xs">{String(currentTenant.description)}</p>
                  </>
                )}
                <Separator />
                <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Calendar className="size-3" />
                  Created {formatDate(currentTenant.createdAt)}
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <p className="text-sm font-medium">{tenantName || (tenantId ? tenantId.slice(0, 8) + '…' : 'Not set')}</p>
                <p className="text-muted-foreground text-xs">{tenantId ? `ID: ${tenantId}` : 'No tenant selected'}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {isSuper && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Users className="text-muted-foreground size-4" />
                <CardTitle className="text-sm font-medium">Platform Stats</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-muted-foreground text-xs">Total Tenants</p>
                  {tenantsLoading ? (
                    <Skeleton className="mt-1 h-6 w-12" />
                  ) : (
                    <p className="text-2xl font-bold tabular-nums">{tenantsData?.count ?? 0}</p>
                  )}
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Total Users</p>
                  {usersLoading ? <Skeleton className="mt-1 h-6 w-12" /> : <p className="text-2xl font-bold tabular-nums">{usersData?.count ?? 0}</p>}
                </div>
              </div>
              <Separator />
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
                  <Link to="/admin/tenants">
                    <Building2 className="mr-1 size-3" />
                    Manage Tenants
                    <ArrowRight className="ml-1 size-3" />
                  </Link>
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
                  <Link to="/admin/users">
                    <Users className="mr-1 size-3" />
                    Manage Users
                    <ArrowRight className="ml-1 size-3" />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </Main>
  );
}
