import { useArcaSttProvider } from '@arcaai/vox/compat';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Switch } from '@arcaai/ui';
import { toast } from 'sonner';

const STATUS_VARIANT = {
  idle: 'outline',
  switching: 'secondary',
  switched: 'default',
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
          <Badge variant={STATUS_VARIANT[provider.switchStatus] ?? 'outline'}>{provider.switchStatus}</Badge>
        </CardTitle>
        <CardDescription>
          Switches the live transcription engine <strong>mid-session, with no reconnect</strong>. ON uses the SDK-configured pipeline
          from this config; OFF falls back to the tenant admin&apos;s default provider.
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
            Active: <span className="font-mono">{provider.activeProvider?.name ?? provider.activeProvider?.pipelineId ?? '—'}</span>
          </div>
          {provider.isFallbackActive ? <Badge variant="secondary">fallback active</Badge> : null}
        </div>
      </CardContent>
    </Card>
  );
}
