import { useState, useCallback, useMemo } from 'react';
import type { TenantAudioConfig } from '@arcaai/vox';
import type { TenantConfig, UpdateTenantConfigItem } from '@/features/admin/api/tenants';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { Input } from '@arcaai/ui/input';
import { Button } from '@arcaai/ui/button';
import { Check, X, Save, Loader2, Mic, AudioLines, Volume2 } from 'lucide-react';

interface TenantSettingsPanelProps {
  tenantConfig: TenantAudioConfig | null;
  rawConfigs?: TenantConfig[];
  onSave: (changes: UpdateTenantConfigItem[]) => void;
  isSaving: boolean;
}

const FEATURE_FLAG_LABELS: Record<string, string> = {
  realTimeTranscription: 'Real-time Transcription',
  nerExtraction: 'NER Extraction',
  codeSwitching: 'Code Switching',
  dnaStyle: 'DNA Writing Style',
  crossChainSummary: 'Cross-Chain Summary',
};

const NAMESPACE_ORDER = ['general', 'stt', 'smr', 'feature-flags', 'ux-constants'] as const;
const NAMESPACE_LABELS: Record<string, string> = {
  general: 'General',
  stt: 'Speech-to-Text',
  smr: 'Summarization',
  'feature-flags': 'Feature Flags',
  'ux-constants': 'Available Models',
};

interface ModelItem {
  id: string;
  name: string;
  size?: string;
  description?: string;
  [key: string]: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const UX_CONSTANT_KEYS = new Set(['local-asr-models', 'local-vad-models', 'local-noise-suppression-models']);

const MODEL_CATEGORY_META: Record<string, { label: string; icon: typeof Mic }> = {
  'local-asr-models': { label: 'Speech-to-Text (ASR)', icon: Mic },
  'local-vad-models': { label: 'Voice Activity Detection', icon: AudioLines },
  'local-noise-suppression-models': { label: 'Noise Suppression', icon: Volume2 },
};

function parseModelList(value: string): ModelItem[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item, index) => {
        if (!item || typeof item !== 'object') return null;
        const candidate = item as ModelItem;
        const id =
          typeof candidate.id === 'string' && candidate.id.length > 0
            ? candidate.id
            : typeof candidate.name === 'string' && candidate.name.length > 0
              ? candidate.name
              : `model-${index}`;
        return {
          ...candidate,
          id,
          name: typeof candidate.name === 'string' ? candidate.name : id,
        };
      })
      .filter((item): item is ModelItem => item != null);
  } catch {
    return [];
  }
}

function SettingRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function SettingRowSkeleton() {
  return (
    <div className="flex items-center justify-between py-2">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-4 w-24" />
    </div>
  );
}

function SettingsCardSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent>
        <div className="flex flex-col">
          {Array.from({ length: rows }).map((_, i) => (
            <SettingRowSkeleton key={i} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function EditableRow({
  config,
  editedValue,
  onChange,
}: {
  config: TenantConfig;
  editedValue: string | undefined;
  onChange: (id: string, value: string) => void;
}) {
  const currentValue = editedValue ?? config.value;
  const isBool = config.dataType === 'Boolean';

  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-muted-foreground text-sm">{config.name}</span>
      {isBool ? (
        <Switch
          checked={currentValue === 'true' || currentValue === '1'}
          onCheckedChange={(checked: boolean) => onChange(config.id, String(checked))}
        />
      ) : (
        <Input
          className="h-8 w-40 text-right text-sm"
          value={currentValue}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(config.id, e.target.value)}
        />
      )}
    </div>
  );
}

function UxConstantsCard({ configs }: { configs: TenantConfig[] }) {
  return (
    <Card className="sm:col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{NAMESPACE_LABELS['ux-constants']}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          {configs.map((cfg) => {
            const models = parseModelList(cfg.value);
            const meta = MODEL_CATEGORY_META[cfg.key];
            const Icon = meta?.icon;
            return (
              <div key={cfg.id}>
                <div className="mb-2 flex items-center gap-2">
                  {Icon && <Icon className="text-muted-foreground size-4" />}
                  <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">{meta?.label ?? cfg.name}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {models.map((m, index) => (
                    <Badge key={`${cfg.id}-${m.id}-${index}`} variant="secondary" className="gap-1.5 py-1">
                      <code className="text-xs">{m.id}</code>
                      <span className="text-muted-foreground text-xs">{m.name}</span>
                      {m.size && <span className="text-muted-foreground/70 text-xs">({m.size})</span>}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ReadOnlyPanel({ tenantConfig }: { tenantConfig: TenantAudioConfig }) {
  const hasGeneralSettings = !!tenantConfig.defaultLanguage;
  const hasSttSettings = !!tenantConfig.defaultSttModel || tenantConfig.vadSensitivity != null;
  const hasSmrSettings = !!tenantConfig.defaultSmrProvider || !!tenantConfig.defaultSmrModel;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {hasGeneralSettings && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">General</CardTitle>
          </CardHeader>
          <CardContent>{tenantConfig.defaultLanguage && <SettingRow label="Default Language" value={tenantConfig.defaultLanguage} />}</CardContent>
        </Card>
      )}

      {hasSttSettings && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Speech-to-Text</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col">
              {tenantConfig.defaultSttModel && (
                <SettingRow
                  label="Default STT Model"
                  value={<code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{tenantConfig.defaultSttModel}</code>}
                />
              )}
              {tenantConfig.vadSensitivity != null && <SettingRow label="VAD Sensitivity" value={String(tenantConfig.vadSensitivity)} />}
            </div>
          </CardContent>
        </Card>
      )}

      {hasSmrSettings && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Summarization</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col">
              {tenantConfig.defaultSmrProvider && (
                <SettingRow
                  label="Default SMR Provider"
                  value={<code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{tenantConfig.defaultSmrProvider}</code>}
                />
              )}
              {tenantConfig.defaultSmrModel && (
                <SettingRow
                  label="Default SMR Model"
                  value={<code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{tenantConfig.defaultSmrModel}</code>}
                />
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className={!hasGeneralSettings && !hasSttSettings && !hasSmrSettings ? 'sm:col-span-2' : ''}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Feature Flags</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            {Object.entries(tenantConfig.features).map(([key, enabled]) => (
              <div key={key} className="flex items-center justify-between">
                <span className="text-muted-foreground text-sm">{FEATURE_FLAG_LABELS[key] ?? key}</span>
                <Badge variant={enabled ? 'default' : 'outline'} className={enabled ? '' : 'text-muted-foreground'}>
                  {enabled ? <Check className="mr-1 size-3" /> : <X className="mr-1 size-3" />}
                  {enabled ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function TenantSettingsPanel({ tenantConfig, rawConfigs, onSave, isSaving }: TenantSettingsPanelProps) {
  const [edits, setEdits] = useState<Record<string, string>>({});

  const handleChange = useCallback((id: string, value: string) => {
    setEdits((prev) => ({ ...prev, [id]: value }));
  }, []);

  const hasChanges = useMemo(() => {
    if (!rawConfigs) return false;
    return Object.entries(edits).some(([id, val]) => {
      const original = rawConfigs.find((c) => c.id === id);
      return original && original.value !== val;
    });
  }, [edits, rawConfigs]);

  const handleSave = useCallback(() => {
    if (!rawConfigs) return;
    const changes: UpdateTenantConfigItem[] = Object.entries(edits)
      .filter(([id, val]) => {
        const original = rawConfigs.find((c) => c.id === id);
        return original && original.value !== val;
      })
      .map(([id, value]) => ({ id, value }));
    if (changes.length > 0) onSave(changes);
  }, [edits, rawConfigs, onSave]);

  if (!tenantConfig) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <SettingsCardSkeleton rows={1} />
        <SettingsCardSkeleton rows={2} />
        <SettingsCardSkeleton rows={2} />
        <SettingsCardSkeleton rows={5} />
      </div>
    );
  }

  if (!rawConfigs) {
    return <ReadOnlyPanel tenantConfig={tenantConfig} />;
  }

  const grouped = new Map<string, TenantConfig[]>();
  for (const cfg of rawConfigs) {
    const ns = cfg.namespace ?? 'general';
    const list = grouped.get(ns) ?? [];
    list.push(cfg);
    grouped.set(ns, list);
  }

  const uxConstantConfigs = grouped.get('ux-constants');

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {NAMESPACE_ORDER.map((ns) => {
          if (ns === 'ux-constants') return null;
          const items = grouped.get(ns);
          if (!items || items.length === 0) return null;
          return (
            <Card key={ns}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{NAMESPACE_LABELS[ns] ?? ns}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col">
                  {items.map((cfg) => (
                    <EditableRow key={cfg.id} config={cfg} editedValue={edits[cfg.id]} onChange={handleChange} />
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}

        {uxConstantConfigs && uxConstantConfigs.length > 0 && <UxConstantsCard configs={uxConstantConfigs} />}
      </div>

      {hasChanges && (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            Save Changes
          </Button>
        </div>
      )}
    </div>
  );
}
