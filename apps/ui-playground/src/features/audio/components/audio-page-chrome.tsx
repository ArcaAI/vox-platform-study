import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import { RotateCcw, UserCheck } from 'lucide-react';

interface AudioPageHeaderActionProps {
  isImpersonating: boolean;
  impersonatedUsername?: string;
  activeUsername?: string;
  onReset: () => void;
}

export function AudioPageHeaderAction({ isImpersonating, impersonatedUsername, activeUsername, onReset }: AudioPageHeaderActionProps) {
  return (
    <div className="flex items-center gap-2">
      {isImpersonating && (
        <Badge variant="destructive" className="gap-1.5">
          <UserCheck className="size-3.5" />
          Acting as: {impersonatedUsername ?? 'Unknown'}
        </Badge>
      )}
      {activeUsername && (
        <Badge variant="outline" className="gap-1.5 text-xs">
          {activeUsername}
        </Badge>
      )}
      <Button variant="outline" size="sm" onClick={onReset}>
        <RotateCcw className="mr-1.5 size-3.5" />
        Reset
      </Button>
    </div>
  );
}

interface AudioImpersonationBannerProps {
  isImpersonating: boolean;
  impersonatedUsername?: string;
  description?: string;
}

export function AudioImpersonationBanner({ isImpersonating, impersonatedUsername, description }: AudioImpersonationBannerProps) {
  if (!isImpersonating) {
    return null;
  }

  return (
    <Card className="mb-4 border-amber-500/30 bg-amber-500/5">
      <CardContent className="flex items-center gap-3 py-3">
        <UserCheck className="size-5 text-amber-600" />
        <div>
          <p className="text-sm font-medium">Impersonation Active</p>
          <p className="text-muted-foreground text-xs">
            You are viewing this page as <strong>{impersonatedUsername ?? 'Unknown'}</strong>.{description ? ` ${description}` : ''}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
