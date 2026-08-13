'use client';

/**
 * @arcaai/vox - useArcaDevices
 *
 * Runtime discovery of audio INPUT devices for a microphone picker.
 *
 * Every consumer that let a user choose a microphone was rebuilding this, and
 * getting it wrong in the same three ways:
 *
 *   1. `enumerateDevices()` before permission returns entries with EMPTY
 *      labels. A picker built on that shows "Microphone 1 / Microphone 2 /
 *      Microphone 3" — unusable, and indistinguishable from having no devices.
 *      Hence {@link UseArcaDevicesReturn.permission} and `requestPermission()`.
 *   2. Nothing listened for `devicechange`, so a microphone plugged in AFTER
 *      the picker rendered never showed up. Hence the subscription below.
 *   3. `deviceId` is not a durable identity — it rotates per origin and
 *      permission state, and `getUserMedia` requests it with `{ exact }`, so a
 *      persisted id eventually throws `OverconstrainedError`. Hence
 *      {@link UseArcaDevicesReturn.resolveDeviceId}: persist `(label, groupId)`
 *      and re-resolve to a live id at start time.
 *
 * Deliberately provider-free — no store, no API client. A device picker must be
 * able to render before any SDK session exists.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** An audio input device, narrowed to the fields a picker actually needs. */
export interface ArcaAudioDevice {
  deviceId: string;
  label: string;
  groupId: string;
}

/**
 * A persisted device choice. Store ALL THREE and pass them back to
 * {@link UseArcaDevicesReturn.resolveDeviceId} — the id alone is not durable.
 */
export interface ArcaDevicePreference {
  deviceId?: string;
  label?: string;
  groupId?: string;
}

export type ArcaDevicePermission = 'prompt' | 'granted' | 'denied';

export interface UseArcaDevicesReturn {
  /** Audio INPUT devices, newest enumeration. `[]` when unsupported or none. */
  devices: ArcaAudioDevice[];
  /**
   * `granted` once labels are readable (the only reliable cross-browser signal
   * that mic permission is held), `denied` after the user refuses a
   * `requestPermission()`, `prompt` otherwise.
   */
  permission: ArcaDevicePermission;
  /** False when the runtime has no `navigator.mediaDevices` (SSR, insecure origin). */
  isSupported: boolean;
  /** Re-enumerate now. Safe to call any time; resolves quietly when unsupported. */
  refresh: () => Promise<void>;
  /**
   * Prompt for microphone access, release the probe stream immediately, then
   * re-enumerate so labels are populated. Returns whether access was granted;
   * never throws for a refusal.
   */
  requestPermission: () => Promise<boolean>;
  /**
   * Resolve a persisted preference to a CURRENTLY VALID `deviceId`:
   * exact id → (label + groupId) → label → `undefined`.
   *
   * `undefined` means "that device is genuinely not here" — fall back to the
   * system default and say which device you opened. It never returns a
   * different device as a guess.
   */
  resolveDeviceId: (preference: ArcaDevicePreference) => string | undefined;
}

function getMediaDevices(): MediaDevices | undefined {
  if (typeof navigator === 'undefined') return undefined;
  return navigator.mediaDevices;
}

export function useArcaDevices(): UseArcaDevicesReturn {
  const [devices, setDevices] = useState<ArcaAudioDevice[]>([]);
  const [permission, setPermission] = useState<ArcaDevicePermission>('prompt');
  // A refusal is sticky: labels stay blank afterwards, and re-deriving
  // `prompt` from that would erase the one fact we actually learned.
  const deniedRef = useRef(false);
  const isSupported = !!getMediaDevices()?.enumerateDevices;

  const refresh = useCallback(async (): Promise<void> => {
    const md = getMediaDevices();
    if (!md?.enumerateDevices) return;
    let all: MediaDeviceInfo[];
    try {
      all = await md.enumerateDevices();
    } catch {
      // Enumeration can reject on a revoked/locked device set; an empty list is
      // the honest answer, not a crash inside a picker.
      setDevices([]);
      return;
    }
    const inputs = all.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }));
    setDevices(inputs);
    if (!deniedRef.current) {
      setPermission(inputs.some((d) => d.label) ? 'granted' : 'prompt');
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    const md = getMediaDevices();
    if (!md?.getUserMedia) return false;
    try {
      const stream = await md.getUserMedia({ audio: true });
      // Release it at once — holding it would keep the browser's recording
      // indicator lit for as long as the picker is open.
      stream.getTracks().forEach((t) => t.stop());
      deniedRef.current = false;
      setPermission('granted');
      await refresh();
      return true;
    } catch {
      deniedRef.current = true;
      setPermission('denied');
      return false;
    }
  }, [refresh]);

  useEffect(() => {
    const md = getMediaDevices();
    if (!md?.enumerateDevices) return;

    void refresh();

    if (typeof md.addEventListener !== 'function') return;
    const onDeviceChange = () => void refresh();
    md.addEventListener('devicechange', onDeviceChange);
    return () => md.removeEventListener?.('devicechange', onDeviceChange);
  }, [refresh]);

  const resolveDeviceId = useCallback(
    (preference: ArcaDevicePreference): string | undefined => {
      const { deviceId, label, groupId } = preference;
      if (deviceId && devices.some((d) => d.deviceId === deviceId)) return deviceId;
      if (label && groupId) {
        const exact = devices.find((d) => d.label === label && d.groupId === groupId);
        if (exact) return exact.deviceId;
      }
      if (label) {
        const byLabel = devices.find((d) => d.label === label);
        if (byLabel) return byLabel.deviceId;
      }
      return undefined;
    },
    [devices],
  );

  return useMemo(
    () => ({ devices, permission, isSupported, refresh, requestPermission, resolveDeviceId }),
    [devices, permission, isSupported, refresh, requestPermission, resolveDeviceId],
  );
}
