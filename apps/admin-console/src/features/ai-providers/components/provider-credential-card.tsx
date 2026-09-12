'use client';

import { useId, useState } from 'react';
import { IconPlugConnectedX, IconRestore, IconStar, IconTestPipe } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import {
  useDeleteProviderConnection,
  useProviderConnection,
  usePutProviderConnection,
  useResetProviderConnection,
  useTestProviderConnection,
} from '../api/hooks';
import {
  CONNECTION_CEILINGS,
  connectionStateOf,
  declarableService,
  gatewayErrorCode,
  platformStateOf,
  type ConnectionCeiling,
  type ConnectionState,
  type PlatformConnectionState,
  type PlatformDefaultConnection,
  type ProviderService,
  type ReadinessEngine,
} from '../api/types';
import { ConnectionModelsEditor } from './connection-models-editor';
import { platformDefaultHint } from './platform-defaults-panel';
import { classOf, type ProviderField, type ProviderMeta } from './provider-meta';
import type { ProviderTier } from './use-provider-scope';

/** Rule 10: skeleton shaped like the loaded card. */
function CardSkeleton() {
  return (
    <Card className="gap-3 p-4" aria-hidden>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-8 w-full" />
      <div className="flex justify-end">
        <Skeleton className="h-8 w-28" />
      </div>
    </Card>
  );
}

/**
 * The three-state vocabulary of a `(service, provider)` row, as the console
 * names it. Mirrors the gateway's `CONNECTION_ENABLED_SEMANTICS`: absent = the
 * platform default may serve; enabled + keyed = this tenant's own credential
 * serves; disabled = a VETO that blocks the platform key too.
 */
const STATE_LABEL: Record<ConnectionState, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  'platform-default': { label: 'Use platform default', variant: 'outline' },
  'bring-your-own': { label: 'Bring your own', variant: 'default' },
  disabled: { label: 'Disabled for this tenant', variant: 'destructive' },
};

/**
 * The PLATFORM tier's own vocabulary (TASK-932 R-11).
 *
 * The map above is written from a tenant's point of view and says so in every
 * word. Rendering it on a SYSTEM row is what produced "no key · Disabled for
 * this tenant" on the platform's own weight store — three claims, all wrong: it
 * needs no key, there is no tenant, and it was not a refusal.
 */
const PLATFORM_STATE_LABEL: Record<PlatformConnectionState, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  'not-configured': { label: 'Not configured', variant: 'outline' },
  'built-in': { label: 'Built-in default', variant: 'secondary' },
  configured: { label: 'Configured', variant: 'default' },
  off: { label: 'Off', variant: 'destructive' },
};

/**
 * A NON-DEFAULT connection's own vocabulary (TASK-958 D-6).
 *
 * The tenant map above is written about a PROVIDER: "use platform default",
 * "disabled for this tenant" — claims about the whole vendor, true only of the
 * row the provider-name cascade actually reads, which is the DEFAULT one.
 * Applied to a sibling every word of it is wrong: a keyless sibling is not
 * "using the platform default" (nothing resolves through it at all), and a
 * disabled sibling vetoes NOTHING — it fails its own bindings closed and the
 * chain walks on. Same defect shape as R-11, one tier down.
 */
const SIBLING_STATE_LABEL: Record<ConnectionState, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  'platform-default': { label: 'No key yet', variant: 'outline' },
  'bring-your-own': { label: 'Bring your own', variant: 'default' },
  disabled: { label: 'Not in use', variant: 'outline' },
};

/** Readiness, as an engine card shows it. `unknown` = not measured, never a verdict. */
const READINESS_LABEL: Record<ReadinessEngine['status'], { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  up: { label: 'reachable', variant: 'secondary' },
  down: { label: 'not answering', variant: 'destructive' },
  unknown: { label: 'not measured', variant: 'outline' },
};

/** Parse a ceiling input: blank = clear (null); a positive integer = the cap; anything else = invalid. */
function parseCeiling(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * One `(service, provider)` connection card — the shared masked credential
 * interaction (state badge, a WRITE-ONLY password field, per-provider fields,
 * the TASK-862 connection CEILINGS, an ephemeral "Test connection" probe,
 * inline remove confirmation, toasts, OCC If-Match) generalized over the
 * unified `admin/providers/:service` route so ONE component drives every tab.
 *
 * `tenantId` is the tier the screen selected (SYSTEM or the working tenant);
 * every read and write on this card carries it.
 *
 * The key is never rendered, never returned by any read, and there is no
 * reveal flow — the field always starts empty and reports only Configured /
 * None. The probe re-tests a STORED key without the operator re-entering it.
 */
export function ProviderCredentialCard({
  service,
  meta,
  slug,
  connectionName,
  defaultBadge = false,
  canMakeDefault = false,
  autoFocusKey = false,
  tenantId,
  tier = 'tenant',
  readiness,
  resettable = false,
  enabled: queriesEnabled = true,
  platformDefault,
}: {
  service: ProviderService;
  meta: ProviderMeta;
  /**
   * TASK-958 — the CONNECTION this card edits. Defaults to `meta.id`, which is
   * the slug of every row that exists today (and of the one a tenant creates
   * first), so an unqualified card is byte-for-byte the card it was before.
   */
  slug?: string;
  /** The tenant's label for a sibling connection; the title reads `‹Provider› · ‹name›`. */
  connectionName?: string | null;
  /** Render the `Default` badge — the group passes it only where a provider HAS siblings. */
  defaultBadge?: boolean;
  /** Offer "Make default": a sibling that exists and is not already the default. */
  canMakeDefault?: boolean;
  /** Focus the key field on mount — where the dialog that just created this row sends the admin. */
  autoFocusKey?: boolean;
  tenantId?: string;
  /** Which tier this card is editing — it decides the WORDING, not the route. */
  tier?: ProviderTier;
  /** The last readiness observation for this engine, when there is one. */
  readiness?: ReadinessEngine | undefined;
  /** Whether this `(service, provider)` ships a built-in default to reset to. */
  resettable?: boolean;
  enabled?: boolean;
  /**
   * TASK-954 — the platform row this tenant would inherit, with the cascade's
   * verdict, so a card that says "Use platform default" can also say whether
   * that default exists. Tenant tier only; undefined until the tab has read it.
   */
  platformDefault?: PlatformDefaultConnection | undefined;
}) {
  const uid = useId();
  const connectionSlug = slug ?? meta.id;
  const isSibling = connectionSlug !== meta.id;
  // What this card is CALLED, everywhere a message or a label names it.
  const title = isSibling ? `${meta.label} · ${connectionName?.trim() || connectionSlug}` : meta.label;
  const query = useProviderConnection(service, connectionSlug, tenantId, queriesEnabled);
  const putMutation = usePutProviderConnection();
  const testMutation = useTestProviderConnection();
  const resetMutation = useResetProviderConnection();

  const [apiKey, setApiKey] = useState('');
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [ceilingDraft, setCeilingDraft] = useState<Partial<Record<ConnectionCeiling, string>> | null>(null);
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // A refused REMOVE is guidance, not a toast: the fix ("make another connection
  // the default first") is an action on this very group, and a toast that
  // vanishes leaves the confirm row saying nothing about why nothing happened.
  const [removeRefusal, setRemoveRefusal] = useState<string | null>(null);
  // TASK-958 — and so is a refused DEFAULT change (400 `CONNECTION_DEFAULT_REQUIRED`).
  // A provider always has exactly one default: you MOVE it, you do not clear it,
  // and the row that takes it is a sibling in this same group. Same reasoning as
  // the remove refusal above — a toast would vanish before the admin reaches the
  // card that unblocks it.
  const [defaultRefusal, setDefaultRefusal] = useState<string | null>(null);

  /**
   * TASK-958 — the SUCCESS half of a remove lives on the MUTATION, not on the
   * `mutate` call, because removing a SIBLING unmounts this very card and a
   * per-call callback does not survive that (see `useDeleteProviderConnection`).
   * The refusal half stays at the call site: a refused remove leaves the card
   * standing by definition, and its guidance belongs on the row it refused.
   */
  const deleteMutation = useDeleteProviderConnection({
    onRemoved: () => {
      toast.success(isSibling ? `${title} connection removed` : `${meta.label} connection removed — the platform default serves this provider again`);
      setConfirmingRemove(false);
      setDraft(null);
      setCeilingDraft(null);
      setEnabledDraft(null);
    },
  });

  if (query.isPending) return <CardSkeleton />;
  if (query.error || !query.data) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const current = query.data.data;
  const etag = query.data.etag;
  const hasKey = current.hasKey;
  const enabled = enabledDraft ?? current.enabled;
  const platformTier = tier === 'platform';
  const state = connectionStateOf(current);
  const platformState = platformStateOf(current);
  const badge = platformTier ? PLATFORM_STATE_LABEL[platformState] : isSibling ? SIBLING_STATE_LABEL[state] : STATE_LABEL[state];
  const providerClass = classOf(meta);
  // A built-in plane row with nothing on it is not "unconfigured" — it is the
  // platform's own default serving it (TASK-932 D-7). Said in words, because
  // "no key" on this card previously read as a fault.
  const runningOnPlatformDefaults = platformTier && providerClass !== 'cloud-byo' && current.version > 0 && current.enabled && !hasKey;
  // What "Use platform default" actually means for THIS tenant today (TASK-954).
  // A SIBLING inherits nothing: the platform default is what the PROVIDER falls
  // back to, which is a fact about the default row, not about this one.
  const inheritedHint = !platformTier && !isSibling && state === 'platform-default' ? platformDefaultHint(platformDefault) : null;
  const currentColumns = current as unknown as Record<string, unknown>;

  /** Stored value for a field: a column reads its column, an `extra` field reads `extraJson[name]`. */
  const storedValue = (field: ProviderField): string => {
    const raw = field.store === 'extra' ? current.extraJson?.[field.name] : currentColumns[field.name];
    return typeof raw === 'string' ? raw : '';
  };
  const valueOf = (field: ProviderField) => draft?.[field.name] ?? storedValue(field);
  const ceilingValueOf = (name: ConnectionCeiling): string => ceilingDraft?.[name] ?? (current[name] == null ? '' : String(current[name]));

  const invalidCeilings = CONNECTION_CEILINGS.filter((c) => parseCeiling(ceilingValueOf(c.name)) === undefined).map((c) => c.label);
  // A key is required on the FIRST save of a VENDOR account; afterwards the
  // stored key stays and the other fields (endpoint, ceilings, enabled) can be
  // edited on their own. A platform-managed row is exempt: a self-hosted engine
  // authenticates nobody, and a built-in plane row is keyless BY DEFAULT, so
  // demanding a key would make the normal case unsavable (TASK-932).
  const keyOptional = providerClass !== 'cloud-byo';
  const canSave = invalidCeilings.length === 0 && !putMutation.isPending && (keyOptional || apiKey.trim().length > 0 || hasKey);

  /**
   * The PUT body, and the three things `extraJson` gets wrong if written like a
   * column (TASK-952 D-2/D-2b/D-6):
   *
   *  - **a blank extras field is an OMITTED key, never `null`.**
   *    `validateProviderExtras` admits scalars and scalar arrays only, so
   *    `{ model: null }` is a 400 — which made four cards unsavable in their
   *    documented default state. (`''` would also pass, but omitting leaves no
   *    junk key in the stored row, and the read path drops `''` anyway.)
   *    Column-backed fields keep sending `null`: that is how a column is cleared.
   *  - **`extraJson` goes out whenever the provider declares ANY extras field.**
   *    An omitted `extraJson` means "leave the stored value untouched", so with
   *    blanks omitted an all-blank form could otherwise never CLEAR the last
   *    stored value.
   *  - **the stored extras are the base, not the card's field list.** The
   *    service replaces `extraJson` wholesale, so a stored key this card has no
   *    field for (e.g. `inheritsPlatformStorage` on the seeded S3 row) would be
   *    destroyed on save. Filled fields set their key, blank fields DELETE it,
   *    every other stored key passes through.
   *
   * Known limitation, deliberately not engineered around: `storedValue` renders
   * a non-string stored value as `''`, so a NUMERIC extra under a card field
   * name would read as blank and be deleted. Every card field is a string field
   * today; a non-string one needs `storedValue` widened first.
   */
  function buildBody(): Record<string, unknown> {
    const body: Record<string, unknown> = { enabled };
    if (apiKey.trim().length > 0) body.apiKey = apiKey.trim();
    const extra: Record<string, unknown> = { ...(current.extraJson ?? {}) };
    let declaresExtras = false;
    for (const field of meta.fields) {
      const value = valueOf(field).trim();
      if (field.store === 'extra') {
        declaresExtras = true;
        if (value) extra[field.name] = value;
        else delete extra[field.name];
      } else {
        body[field.name] = value || null;
      }
    }
    if (declaresExtras) {
      body.extraJson = extra;
    }
    for (const ceiling of CONNECTION_CEILINGS) {
      body[ceiling.name] = parseCeiling(ceilingValueOf(ceiling.name)) ?? null;
    }
    return body;
  }

  function handleSave() {
    if (!canSave) return;
    setDefaultRefusal(null);
    putMutation.mutate(
      { service, slug: connectionSlug, body: buildBody(), etag, tenantId },
      {
        onSuccess: () => {
          toast.success(`${title} connection saved`);
          setApiKey('');
          setDraft(null);
          setCeilingDraft(null);
          setEnabledDraft(null);
        },
        // A 412/428 renders the OCC alert below; only other failures toast.
        onError: (error) => {
          if (gatewayErrorCode(error) === 'CONNECTION_DEFAULT_REQUIRED') {
            setDefaultRefusal(error.message);
            return;
          }
          if (!(error as { isVersionConflict?: boolean; isMissingPrecondition?: boolean }).isVersionConflict) {
            toast.error(error.message);
          }
        },
      },
    );
  }

  function handleTest() {
    // Ephemeral: the typed key (if any) plus the drafted endpoint fields; an
    // omitted key means "probe the stored one".
    const body: Record<string, string> = {};
    // TASK-958 D-2 — on a row that does not exist yet there is NO stored vendor
    // to probe against, and `:slug` is not one either: a named sibling's slug is
    // the tenant's own string. Name the vendor this card is FOR. A stored row
    // already knows what it is (and its provider is immutable), so it is sent
    // only here.
    if (current.version === 0) body.provider = meta.id;
    if (apiKey.trim().length > 0) body.apiKey = apiKey.trim();
    for (const field of meta.fields) {
      if (field.store === 'extra') continue;
      const value = valueOf(field).trim();
      if (value) body[field.name] = value;
    }
    testMutation.mutate(
      { service, slug: connectionSlug, body, tenantId },
      {
        onSuccess: (result) => {
          const via = result.probe === 'auth' ? 'credential verified' : 'endpoint reachable';
          const from = result.source === 'request' ? 'typed values' : result.source === 'tenant' ? 'the tenant row' : 'the platform row';
          if (result.ok) toast.success(`${title}: ${result.message} (${via}, ${from})`);
          else toast.error(`${title}: ${result.message}`);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  function handleReset() {
    resetMutation.mutate(
      { service, slug: connectionSlug, tenantId },
      {
        onSuccess: () => {
          toast.success(`${title} restored to its built-in default`);
          setConfirmingReset(false);
          // Drop every draft: what is on screen now is the SERVER's answer, and
          // keeping a typed endpoint next to a "restored" toast would show the
          // operator the value they just discarded.
          setApiKey('');
          setDraft(null);
          setCeilingDraft(null);
          setEnabledDraft(null);
        },
        onError: (error) => toast.error(error.message),
      },
    );
  }

  function handleRemove() {
    setRemoveRefusal(null);
    deleteMutation.mutate(
      { service, slug: connectionSlug, tenantId },
      {
        onError: (error) => {
          // TASK-958 OQ-6 — the gateway REFUSES to delete a default that still
          // has siblings rather than auto-promoting one, because an automatic
          // promotion silently changes which key every SYSTEM-model agent
          // spends. Say which action unblocks it, in place.
          if (gatewayErrorCode(error) === 'CONNECTION_IS_DEFAULT') {
            setRemoveRefusal(error.message);
            return;
          }
          toast.error(error.message);
        },
      },
    );
  }

  /**
   * TASK-958 D-1/D-3 — make THIS connection the provider's default.
   *
   * A partial PUT on purpose: an omitted field leaves the stored value
   * untouched, so the flip carries no credential, no endpoint and no ceiling —
   * only the one fact it changes. The gateway clears the sibling that held it,
   * in one transaction (D-2), so there is never a moment with two defaults.
   */
  function handleMakeDefault() {
    setDefaultRefusal(null);
    putMutation.mutate(
      { service, slug: connectionSlug, body: { isDefault: true }, etag, tenantId },
      {
        onSuccess: () => {
          setDefaultRefusal(null);
          toast.success(`${title} is now the default ${meta.label} connection`);
        },
        onError: (error) => {
          // A provider always HAS a default, so this refusal is never "your
          // request was wrong" — it is "elect the replacement first", an action
          // on a sibling card a few pixels away. Say it there, not in a toast.
          if (gatewayErrorCode(error) === 'CONNECTION_DEFAULT_REQUIRED') {
            setDefaultRefusal(error.message);
            return;
          }
          if (!(error as { isVersionConflict?: boolean }).isVersionConflict) toast.error(error.message);
        },
      },
    );
  }

  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${uid}-title`} className="text-sm font-medium">
          {title}
        </h3>
        {/*
          TASK-958 — WHICH key a SYSTEM-catalogue model spends. Rendered only
          where the provider actually has more than one connection: a lone card
          is its provider's default by construction, and saying so on every card
          would be noise on the screen it already is.
        */}
        {defaultBadge ? <Badge variant="default">Default</Badge> : null}
        <Badge variant={badge.variant}>{badge.label}</Badge>
        {hasKey ? (
          <Badge variant="secondary">key configured{current.keyVersion != null ? ` · v${current.keyVersion}` : ''}</Badge>
        ) : keyOptional ? null : (
          <Badge variant="outline">no key</Badge>
        )}
        {isSibling ? (
          <Badge variant="outline" className="font-mono text-xs">
            {connectionSlug}
          </Badge>
        ) : null}
        {readiness ? (
          <Badge variant={READINESS_LABEL[readiness.status].variant} title={readiness.detail ?? undefined}>
            {READINESS_LABEL[readiness.status].label}
            {readiness.status === 'up' ? ` · ${readiness.loadedCount}/${readiness.listedCount} loaded` : ''}
          </Badge>
        ) : null}
      </div>
      {meta.hint ? <p className="text-muted-foreground text-xs">{meta.hint}</p> : null}
      {inheritedHint ? <p className="text-muted-foreground text-xs">{inheritedHint}</p> : null}
      {runningOnPlatformDefaults ? (
        <p className="text-muted-foreground text-xs">
          {meta.id === 's3'
            ? 'Using platform storage credentials — endpoint and key pair come from the platform storage configuration.'
            : 'Running on the built-in default — no credential is stored on this connection.'}
        </p>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-key`} className="text-muted-foreground text-xs font-medium">
          {meta.keyLabel ?? 'API key'} {hasKey ? '(enter to rotate)' : ''}
        </Label>
        <Input
          id={`${uid}-key`}
          type="password"
          autoComplete="off"
          // The dialog that created this row closes onto it; focus lands where
          // the one thing still missing (the credential) is typed.
          autoFocus={autoFocusKey}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? '•••••••• (write-only — never shown)' : (meta.keyPlaceholder ?? 'Paste the provider API key')}
          className="h-8 font-mono text-xs"
        />
        <p className="text-muted-foreground text-xs">Encrypted at rest via Vault Transit; the key is never returned by any read.</p>
      </div>

      {meta.fields.map((field) => (
        <div key={field.name} className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-${field.name}`} className="text-muted-foreground text-xs font-medium">
            {field.label}
          </Label>
          <Input
            id={`${uid}-${field.name}`}
            value={valueOf(field)}
            onChange={(event) => setDraft((prev) => ({ ...prev, [field.name]: event.target.value }))}
            placeholder={field.placeholder}
            className="h-8 font-mono text-xs"
          />
        </div>
      ))}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-muted-foreground text-xs font-medium">Ceilings (blank = no opinion)</legend>
        <div className="grid grid-cols-2 gap-2">
          {CONNECTION_CEILINGS.map((ceiling) => (
            <div key={ceiling.name} className="flex flex-col gap-1">
              <Label htmlFor={`${uid}-${ceiling.name}`} className="text-muted-foreground text-xs">
                {ceiling.label}
              </Label>
              <Input
                id={`${uid}-${ceiling.name}`}
                inputMode="numeric"
                value={ceilingValueOf(ceiling.name)}
                onChange={(event) => setCeilingDraft((prev) => ({ ...prev, [ceiling.name]: event.target.value }))}
                placeholder={ceiling.placeholder}
                aria-describedby={`${uid}-${ceiling.name}-help`}
                aria-invalid={parseCeiling(ceilingValueOf(ceiling.name)) === undefined || undefined}
                className="h-8 font-mono text-xs"
              />
              <span id={`${uid}-${ceiling.name}-help`} className="text-muted-foreground text-xs">
                {ceiling.help}
              </span>
            </div>
          ))}
        </div>
        {invalidCeilings.length > 0 ? (
          <p className="text-destructive text-xs" role="alert">
            {invalidCeilings.join(', ')}: enter a positive whole number, or leave blank.
          </p>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Switch id={`${uid}-enabled`} checked={enabled} onCheckedChange={setEnabledDraft} aria-describedby={`${uid}-enabled-help`} />
          <Label htmlFor={`${uid}-enabled`} className="text-muted-foreground text-xs">
            Enabled
          </Label>
        </div>
        {/*
          Turning this OFF is a VETO, not "unused" — it blocks the
          platform-provided key for this provider too, and calls that select it
          fail rather than falling through to another provider. Removing the
          connection entirely returns this provider to "use platform default".
        */}
        <p id={`${uid}-enabled-help`} className="text-muted-foreground pl-10 text-xs">
          {platformTier
            ? enabled
              ? 'This connection serves every tenant that has no opinion of its own.'
              : 'Off means this provider serves nobody — no tenant can inherit it, and nothing falls through to another provider.'
            : isSibling
              ? enabled
                ? 'This credential serves the models declared on THIS connection. It is not the provider’s default, so nothing else resolves through it.'
                : 'Off means the models declared on this connection fail closed and the agent’s next fallback is tried. It does NOT disable this provider — that is the default connection’s switch.'
              : enabled
                ? 'Your credential serves this provider. Remove the connection to fall back to the platform-provided key.'
                : 'Disabled blocks this provider for your tenant entirely — including the platform-provided key. Remove the connection instead to use the platform default.'}
        </p>
      </div>

      {/*
        TASK-890 §3.7a — provider AND model, in one place. Only once a row
        exists: the models are declared ON a connection, so there is nothing to
        hang them off until the credential is saved (the gateway 404s that
        case, and an editor that could only fail is worse than one that waits).
        `discoveredModels` comes from the last probe on THIS card, so "derive"
        reflects the credential the admin just tested.
      */}
      {/*
        NEVER on the platform tier: `declareModels` refuses a SYSTEM connection
        outright (403 — "platform models are declared in /admin/ai-models"), so
        the editor could only ever fail there. One home per fact.
      */}
      {!platformTier && declarableService(service) ? (
        current.version > 0 ? (
          <ConnectionModelsEditor
            service={service}
            slug={connectionSlug}
            label={title}
            tenantId={tenantId}
            models={current.models ?? []}
            discoveredModels={testMutation.data?.discoveredModels}
          />
        ) : (
          // TASK-952 D-3 — on an unsaved row the editor cannot exist, and its
          // absence is SILENT: an admin has no way to learn the model step is
          // coming, which is how this trapped a real user. Say it in one line.
          <p className="text-muted-foreground text-xs">
            The models this connection serves are declared here once the credential is saved.
          </p>
        )
      ) : null}

      <OccConflictAlert
        error={putMutation.error}
        onReload={() => {
          // Reload-merge: the typed key and field drafts stay in memory.
          putMutation.reset();
          void query.refetch();
        }}
      />

      {/*
        A refused delete (409 `CONNECTION_IS_DEFAULT`) says what it says, plus
        the one action that unblocks it — and stays on screen, beside the
        confirmation that produced it.
      */}
      {removeRefusal ? (
        <p className="text-destructive text-xs" role="alert">
          {removeRefusal} Make another connection the default first, then remove this one.
        </p>
      ) : null}

      {/*
        The same treatment for a refused DEFAULT change (400
        `CONNECTION_DEFAULT_REQUIRED`): a provider always has exactly one
        default, so the fix is to ELECT the replacement — a click on a sibling
        card in this group — never to clear this one.
      */}
      {defaultRefusal ? (
        <p className="text-destructive text-xs" role="alert">
          {defaultRefusal} Elect another connection as the default instead; the one it replaces becomes a sibling in the same move.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {canMakeDefault ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleMakeDefault}
            disabled={putMutation.isPending}
            aria-label={`Make ${title} the default ${meta.label} connection`}
          >
            {putMutation.isPending ? <Spinner /> : <IconStar aria-hidden />}
            Make default
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          // A keyless probe is meaningful for a self-hosted engine and for the
          // built-in plane — it is a REACHABILITY test of the endpoint, which is
          // the only question those rows can be wrong about.
          disabled={testMutation.isPending || (!keyOptional && apiKey.trim().length === 0 && !hasKey)}
          aria-label={`Test the ${title} connection`}
          title={!keyOptional && apiKey.trim().length === 0 && !hasKey ? 'Enter a key (or save one) to test this connection' : undefined}
        >
          {testMutation.isPending ? <Spinner /> : <IconTestPipe aria-hidden />}
          Test connection
        </Button>
        {resettable ? (
          confirmingReset ? (
            <div
              role="alertdialog"
              aria-live="assertive"
              aria-label={`Confirm reset of ${meta.label} to its built-in default`}
              className="contents"
            >
              <span className="text-muted-foreground text-xs">
                Restore the built-in default
                {meta.fields.find((f) => f.name === 'baseUrl')?.placeholder ? ` (${meta.fields.find((f) => f.name === 'baseUrl')!.placeholder})` : ''}? Any
                stored credential on this connection is removed.
              </span>
              {/*
                A destructive confirmation replaces its own trigger, so focus
                would otherwise fall back to `<body>` with no announcement
                (M4). `role="alertdialog"` + `aria-live` speak the row; moving
                focus to Cancel (never the destructive action) keeps the safe
                choice the one a stray Enter/Space activates.
              */}
              <Button variant="ghost" size="sm" autoFocus onClick={() => setConfirmingReset(false)} disabled={resetMutation.isPending}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleReset} disabled={resetMutation.isPending}>
                {resetMutation.isPending ? <Spinner /> : null}
                Confirm reset
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirmingReset(true)} aria-label={`Reset ${meta.label} to its built-in default`}>
              <IconRestore aria-hidden />
              Reset to default
            </Button>
          )
        ) : null}
        {!resettable && current.version > 0 ? (
          confirmingRemove ? (
            <div role="alertdialog" aria-live="assertive" aria-label={`Confirm removing the ${title} connection`} className="contents">
              <span className="text-muted-foreground text-xs">
                {isSibling
                  ? 'Remove this connection? Models declared on it are withdrawn with it.'
                  : 'Remove this connection and use the platform default?'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                autoFocus
                onClick={() => {
                  setConfirmingRemove(false);
                  setRemoveRefusal(null);
                }}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleRemove} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Spinner /> : null}
                Confirm remove
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmingRemove(true)}
              aria-label={isSibling ? `Remove the ${title} connection` : `Remove the ${meta.label} connection (use platform default)`}
            >
              <IconPlugConnectedX aria-hidden />
              {isSibling ? 'Remove connection' : 'Use platform default'}
            </Button>
          )
        ) : null}
        <Button size="sm" onClick={handleSave} disabled={!canSave} aria-label={`${hasKey ? 'Save' : 'Save key'} for ${title} · If-Match`}>
          {putMutation.isPending ? <Spinner /> : null}
          {hasKey ? (apiKey.trim().length > 0 ? 'Rotate key & save' : 'Save') : 'Save key'}
        </Button>
      </div>
    </Card>
  );
}
