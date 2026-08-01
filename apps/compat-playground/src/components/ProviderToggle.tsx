import { useArcaSttProvider } from '@arcaai/vox/compat';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Switch } from '@arcaai/ui';
import { toast } from 'sonner';

const STATUS_VARIANT = {
  idle: 'outline',
  switching: 'secondary',
  switched: 'default',
  pending: 'secondary',
  failed: 'destructive',
} as const;

export function ProviderToggle() {
  const raw = useArcaSttProvider({
    onProviderSwitched: (info) => {
      toast.success(`STT engine switched to ${info.toPipeline.name ?? info.toPipeline.id} (${info.reason})`);
    },
    onSwitchFailed: (err) => {
      toast.error(`Provider switch failed: ${err.message}`);
    },
  });
  const provider = raw;
  const busy = provider.switchStatus === 'switching';

  // `activeProvider` is only non-null once a live backend STT session exists.
  // Before that, `switchTo()` in `useArcaSttProvider` records a PENDING
  // pre-start selection (`pendingSttProvider`) rather than performing a live
  // switch — but it still reports `switchStatus: 'switched'` for read
  // consistency (see useArcaSttProvider.ts ~158-212). Presenting that as
  // "switched" here would read as "the engine changed" when nothing has
  // actually happened yet, so relabel it as "pending" at the UI layer instead
  // of touching the hook.
  const isPreSession = provider.activeProvider === null;
  const displayStatus = isPreSession && provider.switchStatus === 'switched' ? 'pending' : provider.switchStatus;

  const handleToggle = async (checked: boolean) => {
    try {
      if (checked) {
        await provider.switchToPipeline();
      } else {
        await provider.switchToDefault();
      }
    } catch {
      // onSwitchFailed above already surfaced a toast.
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          STT engine
          <Badge variant={STATUS_VARIANT[displayStatus] ?? 'outline'}>{displayStatus}</Badge>
        </CardTitle>
        <CardDescription>
          {isPreSession ? (
            <>
              No live session yet — this selection is <strong>queued</strong> and takes effect the moment you start recording. ON uses the
              SDK-configured pipeline from this config; OFF uses the tenant admin&apos;s default provider.
            </>
          ) : (
            <>
              Switches the live transcription engine <strong>mid-session, with no reconnect</strong>. ON uses the SDK-configured pipeline from this
              config; OFF falls back to the tenant admin&apos;s default provider.
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Switch
            checked={provider.usePipeline}
            disabled={busy}
            onCheckedChange={handleToggle}
            aria-label="Toggle STT engine between SDK-configured pipeline and tenant default"
          />
          <span className="text-sm font-medium">{provider.usePipeline ? 'Pipeline (SDK-configured)' : 'Tenant default'}</span>
        </div>
        <div className="text-muted-foreground text-right text-sm">
          <div>
            Active:{' '}
            <span className="font-mono">
              {provider.activeProvider?.name ?? provider.activeProvider?.pipelineId ?? (isPreSession ? 'not started' : '—')}
            </span>
          </div>
          {provider.isFallbackActive ? <Badge variant="secondary">{isPreSession ? 'fallback queued' : 'fallback active'}</Badge> : null}
        </div>
      </CardContent>
    </Card>
  );
}
