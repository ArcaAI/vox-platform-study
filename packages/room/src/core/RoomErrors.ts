/**
 * @arcaai/room - Typed error subclasses for media-capture failures.
 *
 * These extend {@link RoomError} so existing `catch (err: unknown)` handlers
 * that `instanceof`-check `RoomError` continue to match. Each subclass carries
 * a stable string code suitable for analytics, telemetry, and UX dispatch
 * (e.g. dispatching to a "request permission again" CTA vs an "insecure
 * context" warning).
 *
 * Adding new error classes is additive — existing exports remain unchanged.
 */

import { RoomError, RoomErrorCode } from '../types/index.js';

// ============================================================================
// New stable error codes for media-capture and audio-context errors
// ============================================================================

/**
 * Stable string codes for typed Room errors.
 *
 * These are added alongside {@link RoomErrorCode} (which is preserved for
 * backwards compatibility). New error subclasses set their `code` to one of
 * these string values.
 */
export const RoomMediaErrorCode = {
  MicPermissionDenied: 'mic_permission_denied',
  MicNotFound: 'mic_not_found',
  MicInsecureContext: 'mic_insecure_context',
  MicConstraintsUnsupported: 'mic_constraints_unsupported',
  MicResumeTimeout: 'mic_resume_timeout',
  MicUnknown: 'mic_unknown',
} as const;

export type RoomMediaErrorCodeValue = (typeof RoomMediaErrorCode)[keyof typeof RoomMediaErrorCode];

/**
 * Internal helper to attach a stable string code on a RoomError subclass
 * instance. We bypass TypeScript's narrower `code: RoomErrorCode` declared on
 * the parent because the new media error codes are intentionally a separate
 * namespace.
 */
function assignMediaCode(err: RoomError, mediaCode: RoomMediaErrorCodeValue): void {
  Object.defineProperty(err, 'code', {
    value: mediaCode,
    writable: false,
    configurable: true,
    enumerable: true,
  });
}

// ============================================================================
// Microphone permission denied (NotAllowedError)
// ============================================================================

/**
 * Thrown when the user (or browser policy) denies microphone access.
 *
 * Maps from a `DOMException` with `name === 'NotAllowedError'`. The `code`
 * property is `'mic_permission_denied'`.
 */
export class RoomPermissionError extends RoomError {
  constructor(message = 'Microphone permission denied', cause?: Error) {
    super(RoomErrorCode.PERMISSION_DENIED, message, cause);
    this.name = 'RoomPermissionError';
    assignMediaCode(this, RoomMediaErrorCode.MicPermissionDenied);
  }
}

// ============================================================================
// Microphone hardware not found (NotFoundError)
// ============================================================================

/**
 * Thrown when no microphone device is available (e.g. unplugged, no input
 * hardware on a desktop).
 *
 * Maps from `DOMException` with `name === 'NotFoundError'`. The `code`
 * property is `'mic_not_found'`.
 */
export class RoomDeviceError extends RoomError {
  constructor(message = 'No microphone device found', cause?: Error) {
    super(RoomErrorCode.DEVICE_NOT_FOUND, message, cause);
    this.name = 'RoomDeviceError';
    assignMediaCode(this, RoomMediaErrorCode.MicNotFound);
  }
}

// ============================================================================
// Insecure context (SecurityError)
// ============================================================================

/**
 * Thrown when `getUserMedia` is invoked from an insecure origin (HTTP without
 * localhost) or with a `Permissions-Policy: microphone=()` denial from a
 * parent frame.
 *
 * Maps from `DOMException` with `name === 'SecurityError'`. The `code`
 * property is `'mic_insecure_context'`.
 */
export class RoomSecurityError extends RoomError {
  constructor(message = 'Microphone access blocked by insecure context or policy', cause?: Error) {
    super(RoomErrorCode.NOT_SUPPORTED, message, cause);
    this.name = 'RoomSecurityError';
    assignMediaCode(this, RoomMediaErrorCode.MicInsecureContext);
  }
}

// ============================================================================
// Unsupported constraints (OverconstrainedError)
// ============================================================================

/**
 * Thrown when {@link MediaTrackConstraints} cannot be satisfied by any
 * available device — most commonly when a `deviceId: { exact: '...' }`
 * targets a device that has been removed.
 *
 * Maps from `DOMException` with `name === 'OverconstrainedError'`. The `code`
 * property is `'mic_constraints_unsupported'`.
 */
export class RoomConstraintError extends RoomError {
  constructor(message = 'Microphone constraints could not be satisfied', cause?: Error) {
    super(RoomErrorCode.DEVICE_NOT_FOUND, message, cause);
    this.name = 'RoomConstraintError';
    assignMediaCode(this, RoomMediaErrorCode.MicConstraintsUnsupported);
  }
}

// ============================================================================
// AudioContext resume timed out
// ============================================================================

/**
 * Thrown when {@link AudioContextManager.resume} (or the internal
 * `resumeWithTimeout` helper) does not transition the context to `running`
 * within the configured timeout (default 3000ms). Most commonly observed on
 * iOS Safari when no user-gesture has been observed yet — the manager attaches
 * a click/touchstart/keydown handler as a fallback.
 *
 * The `code` property is `'mic_resume_timeout'`.
 */
export class RoomResumeTimeoutError extends RoomError {
  constructor(message = 'AudioContext.resume() timed out', cause?: Error) {
    super(RoomErrorCode.AUDIO_CONTEXT_SUSPENDED, message, cause);
    this.name = 'RoomResumeTimeoutError';
    assignMediaCode(this, RoomMediaErrorCode.MicResumeTimeout);
  }
}

// ============================================================================
// Unknown / fallback
// ============================================================================

/**
 * Thrown for unrecognised `getUserMedia` failures (e.g. exotic browser
 * `DOMException` names or non-`Error` rejections). The `code` property is
 * `'mic_unknown'`.
 */
export class RoomUnknownError extends RoomError {
  constructor(message = 'Unknown microphone error', cause?: Error) {
    super(RoomErrorCode.UNKNOWN, message, cause);
    this.name = 'RoomUnknownError';
    assignMediaCode(this, RoomMediaErrorCode.MicUnknown);
  }
}

// ============================================================================
// Mapping helper
// ============================================================================

/**
 * Map a {@link DOMException} (or any error-shaped value) coming out of
 * `navigator.mediaDevices.getUserMedia` (and friends) into the appropriate
 * typed {@link RoomError} subclass.
 *
 * Falls back to {@link RoomUnknownError} when the input does not look like a
 * recognised `DOMException`.
 */
export function mapGetUserMediaError(error: unknown): RoomError {
  if (error instanceof RoomError) return error;

  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    const message = (error as { message?: unknown }).message;
    const messageStr = typeof message === 'string' ? message : undefined;
    const cause = error instanceof Error ? error : undefined;

    switch (name) {
      case 'NotAllowedError':
        return new RoomPermissionError(messageStr ?? 'Microphone permission denied', cause);
      case 'NotFoundError':
        return new RoomDeviceError(messageStr ?? 'No microphone device found', cause);
      case 'SecurityError':
        return new RoomSecurityError(messageStr ?? 'Microphone access blocked by insecure context or policy', cause);
      case 'OverconstrainedError':
        return new RoomConstraintError(messageStr ?? 'Microphone constraints could not be satisfied', cause);
      default:
        return new RoomUnknownError(messageStr ?? 'Unknown microphone error', cause);
    }
  }

  const fallbackMessage = error instanceof Error ? error.message : 'Unknown microphone error';
  return new RoomUnknownError(fallbackMessage, error instanceof Error ? error : undefined);
}
