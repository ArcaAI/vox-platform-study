import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Spinner } from '@arcaai/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Textarea } from '@arcaai/ui/textarea';
import { ConfigConflictError, useGlobalSettings, useUserSettings } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { groupByNamespace } from '@/features/settings/global-settings';
import { SectionedSettings, type SaveSettingResult, type RevealSecretResult } from '@/features/settings/sectioned-settings';
import { isSuperAdmin } from '@/features/tenants/permissions';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { requireSuperAdmin } from '@/lib/route-guards';
import { useAuthStore } from '@/store/auth-store';

export const Route = createFileRoute('/_authenticated/settings')({
  beforeLoad: ({ context }) => requireSuperAdmin(context),
  component: SettingsPage,
});

const DATA_TYPES = ['String', 'Integer', 'Float', 'Boolean', 'Json', 'DateTime'] as const;

function parseValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

function previewValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ── Global settings ────────────────────────────────────────────────────────────

function GlobalCreateDialog({
  onCreate,
}: {
  onCreate: (input: { key: string; value: unknown; dataType?: string; namespace?: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [key, setKey] = useState('');
  const [namespace, setNamespace] = useState('');
  const [dataType, setDataType] = useState<string>('String');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (open) {
      setKey('');
      setNamespace('');
      setDataType('String');
      setValue('');
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    try {
      await onCreate({ key: key.trim(), value: parseValue(value), dataType, namespace: namespace.trim() || undefined });
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          New setting
        </Button>
      </DialogTrigger>
      <DialogContent className={MOBILE_DIALOG_CONTENT}>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New global setting</DialogTitle>
            <DialogDescription>Platform configuration. JSON values are parsed automatically.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setting-key">Key</Label>
                <Input id="setting-key" value={key} onChange={(e) => setKey(e.target.value)} required autoFocus />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setting-namespace">Namespace</Label>
                <Input id="setting-namespace" value={namespace} onChange={(e) => setNamespace(e.target.value)} placeholder="e.g. features" />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setting-type">Type</Label>
              <Select value={dataType} onValueChange={setDataType}>
                <SelectTrigger id="setting-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATA_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setting-value">Value</Label>
              <Textarea id="setting-value" value={value} onChange={(e) => setValue(e.target.value)} rows={3} className="font-mono text-xs" />
            </div>
          </div>
          <DialogFooter className={MOBILE_DIALOG_FOOTER}>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!key.trim() || saving}>
              {saving ? <Spinner className="size-4" /> : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GlobalSettingsTab() {
  const { settings, isLoading, error, list, get, create, update, revealSecret } = useGlobalSettings();
  // TASK-391 #24 — locked rows are super-admin-writable only (server enforces
  // the `locked` guard; the console mirrors it by disabling the controls).
  const roles = useAuthStore((s) => s.user?.roles);
  const superAdmin = isSuperAdmin(roles);
  const groups = groupByNamespace(settings);

  useEffect(() => {
    // Load ALL global settings (not just the default first page) so secrets in
    // any namespace — e.g. the platform `S3_SECRET_KEY` — are reachable by the
    // TASK-396 reveal affordance. Platform settings are a bounded config set,
    // so a single generous page is sufficient (server total is well under this).
    void list({ limit: 500 }).catch(() => undefined);
  }, [list]);

  const onCreate = async (input: { key: string; value: unknown; dataType?: string; namespace?: string }) => {
    try {
      await create(input);
      toast.success('Setting created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create setting');
      throw err;
    }
  };

  // Per-setting OCC save: a fresh get() caches the ETag before update() PATCHes
  // it. Errors are mapped to a discriminated result the sectioned form batches.
  const saveSetting = useCallback(
    async (id: string, value: unknown): Promise<SaveSettingResult> => {
      try {
        await get(id);
        await update(id, { value });
        return { ok: true };
      } catch (err) {
        if (err instanceof ConfigConflictError) return { ok: false, conflict: true };
        return { ok: false, conflict: false, message: err instanceof Error ? err.message : undefined };
      }
    },
    [get, update],
  );

  const refresh = useCallback(
    () =>
      list()
        .then(() => undefined)
        .catch(() => undefined),
    [list],
  );

  // TASK-396 — gated reveal (step-up re-auth). Maps SDK success/errors into the
  // discriminated result the dialog renders; a 401 (wrong/absent password) or
  // 403 (not super-admin) surfaces as an inline error rather than a throw.
  const onRevealSecret = useCallback(
    async (id: string, password: string): Promise<RevealSecretResult> => {
      try {
        const res = await revealSecret(id, { password });
        return { ok: true, value: typeof res.value === 'string' ? res.value : String(res.value ?? '') };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'Reveal failed — check your password and try again.' };
      }
    },
    [revealSecret],
  );

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <GlobalCreateDialog onCreate={onCreate} />
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn’t load settings</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      <SectionedSettings
        groups={groups}
        superAdmin={superAdmin}
        isLoading={isLoading}
        onSaveSetting={saveSetting}
        onRefresh={refresh}
        onRevealSecret={onRevealSecret}
      />
    </div>
  );
}

// ── User settings (read-only; surfaces the ui.data-grid namespace, TASK-372 D8) ──

function UserSettingsTab() {
  const { settings, isLoading, error, list } = useUserSettings();

  useEffect(() => {
    void list().catch(() => undefined);
  }, [list]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Your saved preferences, including persisted data-grid layouts under the <code className="font-mono">ui.data-grid</code> namespace.
      </p>
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn’t load your settings</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Namespace</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && settings.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                  Loading…
                </TableCell>
              </TableRow>
            ) : settings.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                  No personal settings yet.
                </TableCell>
              </TableRow>
            ) : (
              settings.map((setting) => (
                <TableRow key={setting.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">{String(setting.namespace ?? '—')}</TableCell>
                  <TableCell className="font-medium">{setting.key}</TableCell>
                  <TableCell className="max-w-md truncate font-mono text-xs text-muted-foreground" title={previewValue(setting.value)}>
                    {previewValue(setting.value)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SettingsPage() {
  return (
    <div>
      <PageHeader title="Settings" description="Platform-wide global settings and your personal preferences." />
      <Tabs defaultValue="global">
        <TabsList>
          <TabsTrigger value="global">Global</TabsTrigger>
          <TabsTrigger value="user">My settings</TabsTrigger>
        </TabsList>
        <TabsContent value="global" className="mt-4">
          <GlobalSettingsTab />
        </TabsContent>
        <TabsContent value="user" className="mt-4">
          <UserSettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
