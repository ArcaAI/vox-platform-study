import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Button } from '@arcaai/ui/button';
import { Badge } from '@arcaai/ui/badge';
import { ShieldAlert, UserCog } from 'lucide-react';
import { Link } from '@tanstack/react-router';

interface ImpersonationGuardProps {
  roles: string[];
  featureName?: string;
  featureDescription?: string;
}

export function ImpersonationGuard({ roles, featureName = 'summarization', featureDescription }: ImpersonationGuardProps) {
  const bodyText =
    featureDescription ??
    `Prompt templates and DNA writing styles are personalized per doctor and their department. As an admin (${roles.join(', ')}), you need to impersonate a doctor user to access their department-specific templates and writing style.`;

  return (
    <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
            <ShieldAlert className="size-5 text-amber-600 dark:text-amber-400" />
          </div>
          <div>
            <CardTitle className="text-base">Impersonation Required</CardTitle>
            <CardDescription>Admin users must impersonate a doctor to use {featureName} features</CardDescription>
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
