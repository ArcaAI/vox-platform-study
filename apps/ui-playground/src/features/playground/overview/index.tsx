import { PlaygroundLayout } from '@/components/layout/playground-layout';
import { useAuthStore } from '@/store/auth-store';
import { Badge } from '@arcaai/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Building2, Headphones, MessageSquare, TestTube, Users, Zap } from 'lucide-react';
import { UserList } from './components/user-list';

export default function OverviewPage() {
    const { tenantId, user } = useAuthStore();
    const isSuperAdmin = user?.roles?.includes('SUPER_ADMIN') ?? false;

    return (
        <PlaygroundLayout
            title="Overview"
            description="Configure your testing environment and explore SDK capabilities."
        >
            <Card>
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Zap className="size-5" />
                            <CardTitle>ArcaVox Playground</CardTitle>
                        </div>
                        <div className="flex items-center gap-2">
                            <Building2 className="text-muted-foreground size-4" />
                            {tenantId ? (
                                <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                                    Tenant: {tenantId.slice(0, 8)}…
                                </Badge>
                            ) : (
                                <Badge variant="outline" className="bg-amber-500/15 text-amber-700 dark:text-amber-400">
                                    No tenant
                                </Badge>
                            )}
                            {isSuperAdmin && (
                                <Badge variant="secondary" className="text-xs">
                                    Super Admin
                                </Badge>
                            )}
                        </div>
                    </div>
                    <CardDescription>
                        An interactive testing environment for the ArcaVox SDK
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <p className="text-muted-foreground text-sm leading-relaxed">
                        This playground provides a hands-on environment to test and explore the full
                        capabilities of the ArcaVox SDK. Use impersonation to test API interactions
                        as different users, manage consultations, process audio, and validate
                        integrations — all without affecting production data.
                    </p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <div className="flex items-start gap-3 rounded-lg border p-3">
                            <TestTube className="text-primary mt-0.5 size-4 shrink-0" />
                            <div>
                                <p className="text-sm font-medium">Sandbox Testing</p>
                                <p className="text-muted-foreground text-xs">
                                    Safe environment for experimentation
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3 rounded-lg border p-3">
                            <Users className="text-primary mt-0.5 size-4 shrink-0" />
                            <div>
                                <p className="text-sm font-medium">User Impersonation</p>
                                <p className="text-muted-foreground text-xs">
                                    Test as any user within your scope
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3 rounded-lg border p-3">
                            <MessageSquare className="text-primary mt-0.5 size-4 shrink-0" />
                            <div>
                                <p className="text-sm font-medium">Consultations</p>
                                <p className="text-muted-foreground text-xs">
                                    Create and manage consultation sessions
                                </p>
                            </div>
                        </div>
                        <div className="flex items-start gap-3 rounded-lg border p-3">
                            <Headphones className="text-primary mt-0.5 size-4 shrink-0" />
                            <div>
                                <p className="text-sm font-medium">Audio Processing</p>
                                <p className="text-muted-foreground text-xs">
                                    Record, filter, and analyze audio
                                </p>
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
            <UserList />
        </PlaygroundLayout>
    );
}
