import { Alert, AlertDescription } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Input } from '@arcaai/ui/input';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Switch } from '@arcaai/ui/switch';
import { useUserSettings } from '@arcaai/vox';
import { Info, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { reduceOccConflict } from '@/features/common/occ';

type UserSetting = ReturnType<typeof useUserSettings>['settings'][number];

const settingKey = (s: { namespace?: unknown; key: string }) => `${typeof s.namespace === 'string' ? s.namespace : 'general'}:${s.key}`;

/** `email-digest` / `emailDigest` → `Email digest`. */
function humanize(key: string): string {
  const spaced = key
    .replace(/[-_.]/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

function nsOf(s: UserSetting): string {
  return typeof s.namespace === 'string' && s.namespace ? s.namespace : 'general';
}

/** One preference row — typed control by value shape (boolean → Switch, string/number → Input, else read-only JSON). */
function SettingRow({
  setting,
  canManage,
  saving,
  onSave,
}: {
  setting: UserSetting;
  canManage: boolean;
  saving: boolean;
  onSave: (namespace: string, key: string, value: unknown) => void;
}) {
  const ns = nsOf(setting);
  const value = setting.value;
  const [draft, setDraft] = useState(value == null ? '' : String(value));

  useEffect(() => {
    setDraft(value == null ? '' : String(value));
  }, [value]);

  if (typeof value === 'boolean') {
    return (
      <div className="flex items-center justify-between border-b py-3 last:border-0">
        <span className="text-sm text-foreground">{humanize(setting.key)}</span>
        <Switch
          checked={value}
          disabled={!canManage || saving}
          aria-label={humanize(setting.key)}
          onCheckedChange={(v) => onSave(ns, setting.key, v)}
        />
      </div>
    );
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const dirty = draft !== String(value);
    const commit = () => {
      if (!dirty) return;
      onSave(ns, setting.key, typeof value === 'number' ? Number(draft) : draft);
    };
    return (
      <div className="flex items-center justify-between gap-3 border-b py-3 last:border-0">
        <span className="shrink-0 text-sm text-foreground">{humanize(setting.key)}</span>
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            type={typeof value === 'number' ? 'number' : 'text'}
            disabled={!canManage || saving}
            aria-label={humanize(setting.key)}
            className="h-8 w-40"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
          {canManage ? (
            <Button size="sm" variant="outline" className="h-8" disabled={!dirty || saving} onClick={commit}>
              Save
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-3 border-b py-3 last:border-0">
      <span className="shrink-0 text-sm text-foreground">{humanize(setting.key)}</span>
      <code className="max-w-[60%] truncate rounded bg-muted px-2 py-1 text-xs text-muted-foreground" title={JSON.stringify(value)}>
        {JSON.stringify(value)}
      </code>
    </div>
  );
}

/**
 * 38u **Preferences** tab (TASK-394 P0-1 · TASK-388 #11). Reads/edits ANOTHER
 * user's stored preferences through `useUserSettings().listForUser` /
 * `updateForUser` (the admin `/admin/users/:id/settings` routes, `assertUserInScope`).
 * Settings are free-form `namespace/key/value` rows, so we render them generically
 * grouped by namespace with a type-aware control — no fabricated schema.
 */
export function PreferencesPanel({ userId, canManage }: { userId: string; canManage: boolean }) {
  const { listForUser, updateForUser } = useUserSettings();
  const [rows, setRows] = useState<UserSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    listForUser(userId)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setLoading(false));
  }, [listForUser, userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const groups = useMemo(() => {
    const map = new Map<string, UserSetting[]>();
    for (const s of rows) {
      const ns = nsOf(s);
      const list = map.get(ns) ?? [];
      list.push(s);
      map.set(ns, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  const handleSave = async (namespace: string, key: string, value: unknown) => {
    const id = `${namespace}:${key}`;
    setSavingKey(id);
    try {
      const updated = await updateForUser(userId, namespace, key, value);
      setRows((prev) => prev.map((s) => (nsOf(s) === namespace && s.key === key ? { ...s, ...updated } : s)));
      toast.success('Preference saved');
    } catch (err) {
      const occ = reduceOccConflict(err);
      if (occ.conflict) {
        toast.error(occ.message);
        refresh();
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to save preference');
      }
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>Couldn’t load preferences — {error.message}</span>
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <Alert>
        <Info />
        <AlertDescription>
          {canManage
            ? 'These are the user’s stored preferences. Changes save immediately to their account.'
            : 'Read-only view of the user’s stored preferences.'}
        </AlertDescription>
      </Alert>

      {groups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SlidersHorizontal />
            </EmptyMedia>
            <EmptyTitle>No preferences yet</EmptyTitle>
            <EmptyDescription>This user hasn’t set any preferences. They’ll appear here once saved.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {groups.map(([ns, items]) => (
            <Card key={ns} className="p-5">
              <h3 className="mb-2 text-sm font-semibold">{humanize(ns)}</h3>
              {items.map((s) => (
                <SettingRow key={settingKey(s)} setting={s} canManage={canManage} saving={savingKey === settingKey(s)} onSave={handleSave} />
              ))}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
