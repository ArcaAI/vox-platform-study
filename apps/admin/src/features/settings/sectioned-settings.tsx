/**
 * TASK-395 P1-4 (§5.6) — sectioned Global Settings form.
 *
 * Replaces the KV table with a namespace-sectioned form: a left section-nav rail
 * (jump-to-section) + a form card that stacks every namespace section, each row
 * rendered with a **type-appropriate control** derived from `dataType`
 * (Boolean→`Switch`, Integer/Float→number, Json/Array→expandable code, else text).
 *
 * Preserves the TASK-391 `locked` write-guard (disabled control + 🔒 "Locked —
 * super-admin only", editable by super-admins) and adds per-row Reset-to-default
 * plus a dirty-state Save/Discard toolbar with per-setting OCC saves.
 *
 * Secrets (`encryptedValue`) render **masked** with the reveal affordance
 * **disabled** — there is no gated reveal endpoint yet (TASK-395 §3 FLAG); the
 * console never invents one.
 */
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Spinner } from '@arcaai/ui/spinner';
import { Switch } from '@arcaai/ui/switch';
import type { GlobalSetting } from '@arcaai/vox';
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Lock, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  hasDefaultValue,
  isSecretSetting,
  isSettingLocked,
  prettyJson,
  settingControlKind,
  settingDefaultValue,
  stringifyForInput,
  type SettingGroup,
} from './global-settings';
import { RevealSecretDialog, type RevealSecretResult } from './reveal-secret-dialog';

/** Result of a single per-setting OCC save (the route maps SDK errors into this). */
export type SaveSettingResult = { ok: true } | { ok: false; conflict: boolean; message?: string };

export type { RevealSecretResult };

interface SectionedSettingsProps {
  /** Namespace-grouped, canonically-ordered settings (from `groupByNamespace`). */
  groups: SettingGroup[];
  /** Super-admins may edit `locked` rows; everyone else sees them read-only. */
  superAdmin: boolean;
  isLoading?: boolean;
  /** Persist one setting (OCC get→update); resolves to a discriminated result. */
  onSaveSetting: (id: string, value: unknown) => Promise<SaveSettingResult>;
  /** Re-list settings to resync baselines/ETags (used after a save conflict). */
  onRefresh: () => Promise<void>;
  /**
   * TASK-396 — reveal ONE secret's plaintext with step-up re-auth. The route
   * wires this to `useGlobalSettings().revealSecret` and maps SDK errors into a
   * discriminated result. Omitted ⇒ the Reveal affordance stays disabled.
   */
  onRevealSecret?: (id: string, password: string) => Promise<RevealSecretResult>;
}

/** Raw control value: `boolean` for a `Switch`, `string` for a text/number `Input`. */
type RawValue = string | boolean;

/** Baseline raw value the control shows before any edit. */
function baselineRaw(setting: GlobalSetting): RawValue {
  return settingControlKind(setting) === 'boolean' ? Boolean(setting.value) : stringifyForInput(setting.value);
}

/** Coerce a raw edit into the typed value to persist, plus whether it's valid. */
function typedValue(setting: GlobalSetting, raw: RawValue): { value: unknown; valid: boolean } {
  const kind = settingControlKind(setting);
  if (kind === 'boolean') return { value: Boolean(raw), valid: true };
  if (kind === 'number') {
    const text = String(raw).trim();
    const n = Number(text);
    return { value: n, valid: text !== '' && Number.isFinite(n) };
  }
  return { value: String(raw), valid: true };
}

export function SectionedSettings({ groups, superAdmin, isLoading, onSaveSetting, onRefresh, onRevealSecret }: SectionedSettingsProps) {
  const [activeKey, setActiveKey] = useState<string>('');
  const [edits, setEdits] = useState<Record<string, RawValue>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  // TASK-396 — transient revealed plaintexts (id -> value), held ONLY in memory
  // and cleared on hide/unmount; never persisted. `revealTarget` is the setting
  // whose step-up dialog is currently open.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealTarget, setRevealTarget] = useState<GlobalSetting | null>(null);
  const revealEnabled = typeof onRevealSecret === 'function';
  const hideRevealed = useCallback(
    (id: string) =>
      setRevealed((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }),
    [],
  );

  // Pick / repair the highlighted section when the roster loads or changes.
  useEffect(() => {
    if (groups.length === 0) return;
    setActiveKey((prev) => (groups.some((g) => g.key === prev) ? prev : groups[0].key));
  }, [groups]);

  const allSettings = useMemo(() => groups.flatMap((g) => g.settings), [groups]);

  const currentRaw = useCallback((setting: GlobalSetting): RawValue => (setting.id in edits ? edits[setting.id] : baselineRaw(setting)), [edits]);

  const isDirty = useCallback(
    (setting: GlobalSetting): boolean => {
      if (!(setting.id in edits)) return false;
      return edits[setting.id] !== baselineRaw(setting);
    },
    [edits],
  );

  const dirtySettings = useMemo(() => allSettings.filter(isDirty), [allSettings, isDirty]);
  // json settings are read-only here; only valid boolean/number/string edits persist.
  const savable = useMemo(
    () =>
      dirtySettings
        .filter((s) => settingControlKind(s) !== 'json')
        .map((s) => ({ setting: s, ...typedValue(s, currentRaw(s)) }))
        .filter((e) => e.valid),
    [dirtySettings, currentRaw],
  );

  const setEdit = (id: string, value: RawValue) => setEdits((prev) => ({ ...prev, [id]: value }));
  const clearEdit = (id: string) =>
    setEdits((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  const discard = () => setEdits({});

  const resetToDefault = (setting: GlobalSetting) => {
    const dv = settingDefaultValue(setting);
    setEdit(setting.id, settingControlKind(setting) === 'boolean' ? Boolean(dv) : stringifyForInput(dv));
  };

  const jumpTo = (key: string) => {
    setActiveKey(key);
    sectionRefs.current[key]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const save = async () => {
    if (savable.length === 0) return;
    setSaving(true);
    let saved = 0;
    let conflicts = 0;
    let failed = 0;
    let firstMessage: string | undefined;
    try {
      for (const { setting, value } of savable) {
        const res = await onSaveSetting(setting.id, value);
        if (res.ok) {
          saved += 1;
          clearEdit(setting.id);
        } else if (res.conflict) {
          conflicts += 1;
          clearEdit(setting.id);
        } else {
          failed += 1;
          firstMessage ??= res.message;
        }
      }
    } finally {
      setSaving(false);
    }
    if (saved > 0) toast.success(`Saved ${saved} setting${saved === 1 ? '' : 's'}`);
    if (conflicts > 0) {
      toast.error('Changed by someone else — refreshed to the latest values.');
      await onRefresh().catch(() => undefined);
    }
    if (failed > 0) toast.error(firstMessage ?? `Failed to save ${failed} setting${failed === 1 ? '' : 's'}`);
  };

  if (isLoading && groups.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border text-sm text-muted-foreground">
        <Spinner className="mr-2 size-4" /> Loading settings…
      </div>
    );
  }
  if (groups.length === 0) {
    return <div className="flex h-40 items-center justify-center rounded-lg border text-sm text-muted-foreground">No settings yet.</div>;
  }

  const dirtyCount = dirtySettings.length;

  return (
    <div className="space-y-3">
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 transition-colors',
          dirtyCount > 0 && 'border-warning/30 bg-warning/5',
        )}
      >
        <div className="flex items-center gap-2 text-sm" role="status" aria-live="polite">
          {dirtyCount > 0 ? (
            <>
              <span aria-hidden className="size-2 rounded-full bg-warning" />
              <span className="font-medium text-warning">
                {dirtyCount} unsaved change{dirtyCount === 1 ? '' : 's'}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">All changes saved</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={discard} disabled={dirtyCount === 0 || saving}>
            Discard
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={savable.length === 0 || saving}>
            {saving ? <Spinner className="size-4" /> : 'Save changes'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[13rem_1fr]">
        <nav
          aria-label="Settings sections"
          className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0 md:sticky md:top-4 md:self-start"
        >
          {groups.map((group) => {
            const active = group.key === activeKey;
            const groupDirty = group.settings.some(isDirty);
            return (
              <button
                key={group.key || '__ungrouped__'}
                type="button"
                aria-current={active ? 'page' : undefined}
                onClick={() => jumpTo(group.key)}
                className={cn(
                  'flex shrink-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors md:shrink',
                  active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <span className="flex items-center gap-1.5">
                  {group.label}
                  {groupDirty ? <span aria-label="unsaved changes in section" className="size-1.5 rounded-full bg-warning" /> : null}
                </span>
                <Badge variant="secondary" className="tabular-nums">
                  {group.settings.length}
                </Badge>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 space-y-4">
          {groups.map((group) => (
            <section
              key={group.key || '__ungrouped__'}
              ref={(el) => {
                sectionRefs.current[group.key] = el;
              }}
              aria-label={group.label}
              className="scroll-mt-4 rounded-lg border"
            >
              <h3 className="border-b px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.label}</h3>
              <div className="divide-y">
                {group.settings.map((setting) => (
                  <SettingRow
                    key={setting.id}
                    setting={setting}
                    superAdmin={superAdmin}
                    raw={currentRaw(setting)}
                    dirty={isDirty(setting)}
                    expanded={Boolean(expanded[setting.id])}
                    onToggleExpanded={() => setExpanded((prev) => ({ ...prev, [setting.id]: !prev[setting.id] }))}
                    onChange={(value) => setEdit(setting.id, value)}
                    onReset={() => resetToDefault(setting)}
                    revealEnabled={revealEnabled}
                    revealedValue={revealed[setting.id]}
                    onOpenReveal={() => setRevealTarget(setting)}
                    onHideReveal={() => hideRevealed(setting.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {/* TASK-396 — single step-up dialog instance, targeted at the row being revealed. */}
      {revealEnabled && onRevealSecret ? (
        <RevealSecretDialog
          open={revealTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRevealTarget(null);
          }}
          settingLabel={revealTarget ? (typeof revealTarget.name === 'string' && revealTarget.name.trim()) || revealTarget.key : ''}
          settingKey={revealTarget?.key ?? ''}
          onReveal={(password) => onRevealSecret(revealTarget?.id ?? '', password)}
          onRevealed={(value) => {
            const id = revealTarget?.id;
            if (id) setRevealed((prev) => ({ ...prev, [id]: value }));
          }}
        />
      ) : null}
    </div>
  );
}

function SettingRow({
  setting,
  superAdmin,
  raw,
  dirty,
  expanded,
  onToggleExpanded,
  onChange,
  onReset,
  revealEnabled,
  revealedValue,
  onOpenReveal,
  onHideReveal,
}: {
  setting: GlobalSetting;
  superAdmin: boolean;
  raw: RawValue;
  dirty: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (value: RawValue) => void;
  onReset: () => void;
  /** TASK-396 — whether a reveal handler is wired (endpoint available). */
  revealEnabled: boolean;
  /** TASK-396 — transient plaintext to show, or undefined while masked. */
  revealedValue?: string;
  /** TASK-396 — open the step-up dialog for this row. */
  onOpenReveal: () => void;
  /** TASK-396 — re-mask this row (drops the transient plaintext). */
  onHideReveal: () => void;
}) {
  const kind = settingControlKind(setting);
  const locked = isSettingLocked(setting);
  const secret = isSecretSetting(setting);
  // Locked rows are super-admin-writable (server-enforced). Secrets are never
  // inline-editable — the plaintext is only reachable via the gated reveal.
  const canWrite = (!locked || superAdmin) && !secret;

  const defaultRaw = kind === 'boolean' ? Boolean(settingDefaultValue(setting)) : stringifyForInput(settingDefaultValue(setting));
  const showReset = canWrite && kind !== 'json' && hasDefaultValue(setting) && String(raw) !== String(defaultRaw);

  const label = (typeof setting.name === 'string' && setting.name.trim()) || setting.key;
  const controlId = `setting-${setting.id}`;

  return (
    <div className="px-4 py-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={canWrite && kind !== 'json' ? controlId : undefined} className="font-medium">
              {label}
            </Label>
            {locked ? (
              <span title="Locked — super-admin only" className="inline-flex text-muted-foreground">
                <Lock className="size-3.5" aria-label="Locked" />
              </span>
            ) : null}
            {secret ? (
              <Badge variant="outline" className="text-[10px] uppercase">
                Secret
              </Badge>
            ) : null}
            {dirty ? <span className="text-[10px] font-medium text-warning">Modified</span> : null}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{setting.key}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:justify-end">
          {secret ? (
            <SecretCell
              label={label}
              revealEnabled={revealEnabled && superAdmin}
              revealedValue={revealedValue}
              onOpenReveal={onOpenReveal}
              onHideReveal={onHideReveal}
            />
          ) : kind === 'boolean' ? (
            <Switch id={controlId} checked={Boolean(raw)} disabled={!canWrite} onCheckedChange={(v) => onChange(Boolean(v))} aria-label={label} />
          ) : kind === 'json' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onToggleExpanded}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'View'} ${label} JSON`}
            >
              {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
              {expanded ? 'Hide' : 'View'} JSON
            </Button>
          ) : (
            <Input
              id={controlId}
              type={kind === 'number' ? 'number' : 'text'}
              value={String(raw)}
              disabled={!canWrite}
              onChange={(e) => onChange(e.target.value)}
              className={cn(kind === 'number' ? 'sm:w-32 text-right tabular-nums' : 'sm:w-64', 'font-mono text-xs')}
            />
          )}
          {showReset ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={onReset}
              title="Reset to default"
              aria-label={`Reset ${label} to default`}
            >
              <RotateCcw className="size-4" />
            </Button>
          ) : null}
        </div>
      </div>
      {kind === 'json' && expanded ? (
        <pre className="mt-3 max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">{prettyJson(setting.value)}</pre>
      ) : null}
    </div>
  );
}

/**
 * TASK-396 — secret value cell. Masked by default with a Reveal button that
 * opens the step-up dialog; once revealed it shows the transient plaintext with
 * Copy + a Hide (re-mask) button. The plaintext lives only in the parent's
 * in-memory state and is dropped on Hide/unmount — never persisted.
 */
function SecretCell({
  label,
  revealEnabled,
  revealedValue,
  onOpenReveal,
  onHideReveal,
}: {
  label: string;
  revealEnabled: boolean;
  revealedValue?: string;
  onOpenReveal: () => void;
  onHideReveal: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isRevealed = typeof revealedValue === 'string';

  const copy = async () => {
    if (!isRevealed) return;
    try {
      await navigator.clipboard.writeText(revealedValue as string);
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed — select the value manually');
    }
  };

  if (isRevealed) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="max-w-[16rem] truncate rounded bg-muted px-2 py-1 font-mono text-xs text-foreground"
          title={revealedValue}
          data-testid="revealed-secret"
        >
          {revealedValue}
        </span>
        <Button type="button" variant="outline" size="icon" className="size-8" aria-label={`Copy ${label}`} onClick={() => void copy()}>
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </Button>
        <Button type="button" variant="outline" size="sm" aria-label={`Hide ${label}`} onClick={onHideReveal}>
          <EyeOff className="size-4" />
          Hide
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-sm tracking-widest text-muted-foreground" aria-label="Secret value hidden">
        ••••••••
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!revealEnabled}
        onClick={onOpenReveal}
        aria-label={revealEnabled ? `Reveal ${label}` : 'Reveal secret (unavailable)'}
        title={revealEnabled ? 'Reveal (super-admin, step-up re-auth, audited)' : 'Reveal is super-admin only'}
      >
        <Eye className="size-4" />
        Reveal
      </Button>
    </div>
  );
}
