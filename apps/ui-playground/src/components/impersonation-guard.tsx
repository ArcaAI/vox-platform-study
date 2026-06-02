import type { ReactNode } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Button } from '@arcaai/ui/button';
import { Badge } from '@arcaai/ui/badge';
import { ShieldAlert, UserCog } from 'lucide-react';
import { Link } from '@tanstack/react-router';

import { useDoctorContext } from '@/features/summarization/hooks/use-doctor-context';

interface ImpersonationGuardProps {
  children: ReactNode;
  /** Human-readable feature name shown in the gate copy. */
  featureName?: string;
  /** Override the default explanatory body text. */
  featureDescription?: string;
}

/**
 * Reusable impersonation gate for impersonation-only playgrounds.
 *
 * Renders `children` when the active context already resolves to a doctor
 * (either the logged-in user is a doctor, or an admin is impersonating one).
 * When an admin has no impersonated doctor active, it blocks the feature and
 * shows a clear call-to-action to start impersonation instead.
 *
 * Impersonation state is sourced from `useDoctorContext`, which reads the
 * shared `useAuthStore` + SDK auth — the same source the other playgrounds use.
 */
export function ImpersonationGuard({ children, featureName = 'this playground', featureDescription }: ImpersonationGuardProps) {
  const { requiresImpersonation, roles } = useDoctorContext();

  if (!requiresImpersonation) {
    return <>{children}</>;
  }

  const bodyText =
    featureDescription ??
    `${featureName} is personalized per doctor. As an admin (${roles.join(', ') || 'no doctor role'}), impersonate a doctor user to view and generate their writing-style reports.`;

  return (
    <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
            <ShieldAlert className="size-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <CardTitle className="text-base">Impersonation Required</CardTitle>
            <CardDescription>Impersonate a doctor to use {featureName}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-muted-foreground text-sm">{bodyText}</p>
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
  );
}
