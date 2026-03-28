import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Badge } from '@arcaai/ui/badge';
import { useBrowserCapabilities } from '@arcaai/room';
import { AlertTriangle, Ban, Info } from 'lucide-react';

export function BrowserCompatibilityBanner() {
  const { limitations, isSupported } = useBrowserCapabilities();

  if (limitations.length === 0) return null;

  const blockers = limitations.filter((l) => l.severity === 'blocker');
  const degraded = limitations.filter((l) => l.severity === 'degraded');
  const infos = limitations.filter((l) => l.severity === 'info');

  return (
    <div className="space-y-2">
      {blockers.map((l) => (
        <Alert key={l.feature} variant="destructive">
          <Ban className="size-4" />
          <AlertTitle className="text-sm">Browser Not Supported</AlertTitle>
          <AlertDescription className="text-xs">
            {l.description}
            {l.workaround && <span className="text-muted-foreground ml-1">{l.workaround}</span>}
          </AlertDescription>
        </Alert>
      ))}
      {degraded.length > 0 && isSupported && (
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertTitle className="text-sm">Limited Browser Support</AlertTitle>
          <AlertDescription className="space-y-1">
            {degraded.map((l) => (
              <div key={l.feature} className="flex items-start gap-2 text-xs">
                <Badge variant="outline" className="shrink-0 text-[9px]">
                  {l.feature}
                </Badge>
                <span>
                  {l.description}
                  {l.workaround && <span className="text-muted-foreground ml-1">{l.workaround}</span>}
                </span>
              </div>
            ))}
          </AlertDescription>
        </Alert>
      )}
      {infos.length > 0 && isSupported && blockers.length === 0 && degraded.length === 0 && (
        <Alert>
          <Info className="size-4" />
          <AlertTitle className="text-sm">Browser Notes</AlertTitle>
          <AlertDescription className="space-y-1">
            {infos.map((l) => (
              <p key={l.feature} className="text-xs">
                {l.description}
              </p>
            ))}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
