/**
 * @arcaai/vox - Microsoft Clarity Transport
 *
 * Transport for Microsoft Clarity integration with support for:
 * - Behavioural monitoring (session replay, heatmaps) — configured Clarity-side
 * - Custom events for errors and completed SDK operations
 * - Low-cardinality custom tags for filtering sessions
 *
 * @see https://learn.microsoft.com/en-us/clarity/
 */

import type { ILogTransport, LogEntry, ClarityTransportConfig, LogLevel } from '../types';
import { LOG_LEVEL_VALUES } from '../types';
import { REDACTED_VALUE } from '../redactor';
import { isProductionEnvironment } from '../environment';

/**
 * Microsoft Clarity SDK interface (loaded dynamically).
 *
 * Mirrors the `@microsoft/clarity` v1 default export exactly. Note what is
 * NOT here, because it shapes this transport:
 *   - There is no `stop()`/`shutdown()`. Once `init()` runs, Clarity records
 *     for the lifetime of the page (see `shutdown()` below).
 *   - `event()` takes a NAME ONLY — no properties/metadata object. Structured
 *     log metadata therefore has to travel as `setTag()` pairs.
 *   - There is no log/message sink. Clarity is a behavioural analytics tool,
 *     not a log backend, which is why this transport defaults to `error`
 *     level instead of the `info` the other transports use.
 */
interface ClarityInstance {
  init: (projectId: string) => void;
  setTag: (key: string, value: string | string[]) => void;
  identify: (customId: string, customSessionId?: string, customPageId?: string, friendlyName?: string) => void;
  consent: (consent?: boolean) => void;
  consentV2: (consentOptions?: { ad_Storage: 'granted' | 'denied'; analytics_Storage: 'granted' | 'denied' }) => void;
  upgrade: (reason: string) => void;
  event: (eventName: string) => void;
}

/** Bound on the pre-initialisation queue so a slow/failed SDK load cannot grow memory without limit. */
const MAX_PENDING_LOGS = 50;

/** Clarity event names are identifiers, not free text — keep them short and boring. */
const MAX_EVENT_NAME_LENGTH = 255;

/** Clarity tag values are filter facets; long values are useless in the dashboard. */
const MAX_TAG_VALUE_LENGTH = 255;

/**
 * Microsoft Clarity transport implementation.
 *
 * **Gated activation — read this before enabling.**
 *
 * Clarity is a SESSION REPLAY product: it reconstructs the DOM of the page.
 * In a HOPE surface that DOM contains live consultation transcripts, patient
 * context and clinician notes — i.e. PHI. Microsoft does not offer a HIPAA
 * Business Associate Agreement for Clarity, so PHI must not reach it.
 *
 * This transport therefore follows the same fail-closed contract as
 * `HighlightTransport` and refuses to initialise unless ALL of the following
 * are true:
 *
 *   1. A non-empty `projectId` is configured. **The project ID is the on/off
 *      switch** — omit it and Clarity is simply off, which lets a developer
 *      bind it to an env var and enable/disable per deployment.
 *   2. `config.enabled` is not `false` (an optional kill switch that leaves
 *      the project ID in place).
 *   3. The deployment is not production — `config.environment` is a
 *      non-production stage name (e.g. `'staging'`), or, when `environment` is
 *      undeclared, `NODE_ENV !== 'production'`. See `environment.ts` for why
 *      the declared stage wins over `NODE_ENV`.
 *
 * If any gate fails the transport enters a permanently-disabled state where
 * `log()` is a hard no-op (no queueing, no buffering, no PHI held in memory)
 * and `initialize()` is a no-op. A misconfigured production deploy therefore
 * silently drops telemetry rather than leaking PHI to Clarity.
 *
 * **What this class cannot enforce.** Clarity's replay masking is a
 * PROJECT-level setting in the Clarity dashboard, not an SDK parameter — the
 * `@microsoft/clarity` package exposes no masking option. Enabling this
 * transport without setting the Clarity project to "Mask All" (and marking
 * transcript surfaces `data-clarity-mask="true"`) will record on-screen text.
 * The gates above are what keep that off production; the dashboard setting is
 * the operator's responsibility.
 *
 * The PHI redactor (`redactPHI`) in `SDKLogger.dispatch()` already strips PHI
 * from every log entry before transports see it, so this transport
 * additionally skips any value that arrives as `[REDACTED]` rather than
 * forwarding the marker to Clarity as a tag.
 */
export class ClarityTransport implements ILogTransport {
  readonly name = 'clarity';
  private config: ClarityTransportConfig;
  private clarity: ClarityInstance | null = null;
  private initialized = false;
  /**
   * Once true, this transport will never send another event and will not even
   * queue them. Set when the activation gate refuses (production env, not
   * opted in, or missing project ID).
   */
  private permanentlyDisabled = false;
  private pendingLogs: LogEntry[] = [];
  private level: LogLevel;
  /** Tags already sent this session — Clarity tags are sticky, so re-sending identical pairs is pure noise. */
  private sentTags = new Map<string, string>();
  private identified = false;

  constructor(config: ClarityTransportConfig) {
    this.config = config;
    // Clarity is not a log sink (no message API), so the default floor is
    // `error` rather than the `info` used by the log-shipping transports.
    // Only errors and completed operations become Clarity events.
    this.level = config.level || 'error';
    if (!ClarityTransport.isAllowedToActivate(config)) {
      this.permanentlyDisabled = true;
      this.pendingLogs = [];
    }
  }

  /**
   * Activation predicate.
   *
   * Pure & static so `SDKLogger.initializeTransports()` can also call it to
   * skip constructing the transport entirely.
   */
  static isAllowedToActivate(config: ClarityTransportConfig): boolean {
    // Explicit kill switch wins over everything, so an operator can disable
    // Clarity without deleting the project ID from their config.
    if (config.enabled === false) return false;
    // The project ID IS the opt-in. No ID (or an empty/whitespace one, which
    // is what an unset env var looks like) means the developer did not
    // configure Clarity, so the transport stays off.
    if (!config.projectId || config.projectId.trim().length === 0) return false;
    // Deployment STAGE, not build mode — a staging deploy is built with
    // NODE_ENV=production by every browser bundler, so a NODE_ENV-only gate
    // would silently kill the transport on staging. See `environment.ts`.
    if (isProductionEnvironment(config.environment)) return false;
    return true;
  }

  /**
   * Initialize the Microsoft Clarity SDK.
   */
  async initialize(): Promise<void> {
    if (this.permanentlyDisabled || this.initialized || typeof window === 'undefined') {
      return;
    }

    try {
      // Dynamic import for browser environments.
      // `@microsoft/clarity` ships a single default export.
      const clarityModule = await import('@microsoft/clarity');
      this.clarity = (clarityModule.default ?? clarityModule) as unknown as ClarityInstance;

      if (!this.clarity || typeof this.clarity.init !== 'function') {
        console.warn('[ClarityTransport] Microsoft Clarity SDK not available');
        this.clarity = null;
        return;
      }

      // Non-empty by construction: `isAllowedToActivate` (re-checked in the
      // constructor) rejects a missing or blank project ID, so reaching here
      // means one was configured.
      this.clarity.init(this.config.projectId!.trim());

      // Clarity's cookie-consent state defaults to granted. When the host app
      // manages consent itself, start denied and let it grant explicitly.
      if (this.config.requireConsent) {
        this.setConsent(false);
      }

      this.initialized = true;

      // Baseline low-cardinality tags so sessions are filterable in the dashboard.
      if (this.config.serviceName) this.tag('vox.service', this.config.serviceName);
      if (this.config.environment) this.tag('vox.environment', this.config.environment);

      // Flush pending logs
      const pending = this.pendingLogs;
      this.pendingLogs = [];
      for (const entry of pending) {
        this.log(entry);
      }
    } catch (error) {
      console.warn('[ClarityTransport] Failed to initialize:', error);
    }
  }

  /**
   * Check if level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.level];
  }

  /**
   * Log entry to Microsoft Clarity.
   *
   * When the transport is permanently disabled (production env, not opted in,
   * or missing project ID) this is a hard no-op — we do not even queue the
   * entry, so a misconfigured deploy cannot silently buffer PHI in memory that
   * a later runtime gate-flip could flush to Clarity.
   */
  log(entry: LogEntry): void {
    if (this.permanentlyDisabled) return;
    if (!this.shouldLog(entry.level)) return;

    if (!this.initialized || !this.clarity) {
      if (this.pendingLogs.length < MAX_PENDING_LOGS) {
        this.pendingLogs.push(entry);
      }
      return;
    }

    this.applyTags(entry);

    if (entry.level === 'error' || entry.level === 'fatal') {
      this.reportError(entry);
      return;
    }

    // Completed operations become behavioural events so funnels in Clarity can
    // be correlated with SDK activity.
    if (entry.operation?.operation && entry.operation.durationMs !== undefined) {
      this.emitEvent(`vox.op.${entry.operation.operation}`);
    }
  }

  /**
   * Apply low-cardinality tags from an entry.
   *
   * Deliberately narrow: Clarity tags are session filter facets, so only
   * dimensions worth slicing sessions by are sent. `correlationId` is the one
   * high-cardinality exception — it is what links a Clarity session replay
   * back to the gateway/Loki logs for the same request, which is the whole
   * point of running this alongside the log transports.
   */
  private applyTags(entry: LogEntry): void {
    if (entry.context) this.tag('vox.context', entry.context);
    if (entry.operation?.component) this.tag('vox.component', entry.operation.component);
    if (entry.correlation?.correlationId) this.tag('vox.correlationId', entry.correlation.correlationId);
    if (entry.user?.tenantId) this.tag('vox.tenantId', entry.user.tenantId);
    if (entry.resource?.sdkVersion) this.tag('vox.sdkVersion', entry.resource.sdkVersion);

    // User identification is opt-in: even a non-PHI user id is a personal
    // identifier being handed to a third party.
    if (this.config.identifyUsers && !this.identified && isUsable(entry.user?.userId)) {
      this.identify(entry.user!.userId as string);
    }
  }

  /**
   * Report an error entry as a Clarity custom event plus error tags.
   *
   * `event()` carries no metadata, so the detail rides along as tags and the
   * event name encodes the error identity.
   */
  private reportError(entry: LogEntry): void {
    const name = entry.error?.name;
    const code = entry.error?.code;

    if (isUsable(name)) this.tag('vox.errorName', name as string);
    if (isUsable(code)) this.tag('vox.errorCode', code as string);
    if (entry.http?.statusCode !== undefined) this.tag('vox.httpStatus', String(entry.http.statusCode));
    this.tag('vox.hasError', 'true');

    const discriminator = (isUsable(code) && code) || (isUsable(name) && name) || entry.level;
    this.emitEvent(`vox.error.${discriminator}`);

    // Errors make a session worth keeping — ask Clarity to prioritise it for
    // recording so the replay is actually available when triaging.
    if (this.config.upgradeOnError) {
      try {
        this.clarity?.upgrade(`vox.error.${discriminator}`);
      } catch (err) {
        console.warn('[ClarityTransport] upgrade failed:', err);
      }
    }
  }

  /**
   * Send a custom event, sanitising the name.
   */
  private emitEvent(rawName: string): void {
    if (!this.clarity) return;
    const eventName = sanitizeName(rawName);
    if (!eventName) return;
    try {
      this.clarity.event(eventName);
    } catch (err) {
      console.warn('[ClarityTransport] event failed:', err);
    }
  }

  /**
   * Set a custom tag, skipping redacted values and duplicate writes.
   */
  private tag(key: string, rawValue: string): void {
    if (!this.clarity) return;
    if (!isUsable(rawValue)) return;

    const value = rawValue.length > MAX_TAG_VALUE_LENGTH ? rawValue.slice(0, MAX_TAG_VALUE_LENGTH) : rawValue;
    if (this.sentTags.get(key) === value) return;

    try {
      this.clarity.setTag(key, value);
      this.sentTags.set(key, value);
    } catch (err) {
      console.warn('[ClarityTransport] setTag failed:', err);
    }
  }

  /**
   * Identify the current user to Clarity.
   *
   * No-op when the value is missing or has been replaced by the PHI redactor.
   */
  identify(customId: string, friendlyName?: string): void {
    if (!this.clarity || !isUsable(customId)) return;
    try {
      this.clarity.identify(customId, undefined, undefined, friendlyName);
      this.identified = true;
    } catch (err) {
      console.warn('[ClarityTransport] identify failed:', err);
    }
  }

  /**
   * Record a custom behavioural event from host application code.
   */
  track(eventName: string): void {
    if (this.permanentlyDisabled) return;
    this.emitEvent(eventName);
  }

  /**
   * Pass cookie-consent state through to Clarity (ConsentV2).
   *
   * `consentV2` supersedes the deprecated `consent` API; we call the modern
   * one and fall back for older SDK builds that only expose `consent`.
   */
  setConsent(granted: boolean): void {
    if (!this.clarity) return;
    const state = granted ? 'granted' : 'denied';
    try {
      if (typeof this.clarity.consentV2 === 'function') {
        this.clarity.consentV2({ ad_Storage: state, analytics_Storage: state });
      } else if (typeof this.clarity.consent === 'function') {
        this.clarity.consent(granted);
      }
    } catch (err) {
      console.warn('[ClarityTransport] consent failed:', err);
    }
  }

  async flush(): Promise<void> {
    // Clarity uploads on its own schedule; there is no flush hook to call.
  }

  /**
   * Shut the transport down.
   *
   * Clarity exposes NO stop/teardown API — once `init()` has run, recording
   * continues for the lifetime of the page. The closest available action is
   * revoking consent, which stops Clarity writing cookies and gathering
   * further analytics data. Local state is cleared so nothing else is sent
   * through this instance.
   */
  async shutdown(): Promise<void> {
    if (this.clarity) {
      this.setConsent(false);
    }
    this.initialized = false;
    this.pendingLogs = [];
    this.sentTags.clear();
    this.identified = false;
  }
}

/**
 * A value is usable if it is a non-empty string that survived PHI redaction.
 * `redactPHI()` runs before any transport sees an entry, so `[REDACTED]`
 * markers are expected here and must never be forwarded to Clarity.
 */
function isUsable(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value !== REDACTED_VALUE;
}

/**
 * Reduce an event name to a safe identifier.
 */
function sanitizeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_EVENT_NAME_LENGTH);
}
