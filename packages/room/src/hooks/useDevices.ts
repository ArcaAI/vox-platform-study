/**
 * @arcaai/room - useDevices Hook
 *
 * Hook for enumerating and selecting audio devices.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { AudioDevice } from '../types/index.js';

/**
 * Device kind filter.
 */
export type DeviceKind = 'audioinput' | 'audiooutput' | 'all';

/**
 * Options for useDevices hook.
 */
export interface UseDevicesOptions {
  /** Request permissions on mount */
  requestPermissions?: boolean;
  /** Auto-refresh device list */
  autoRefresh?: boolean;
}

/**
 * Return value of useDevices hook.
 */
export interface UseDevicesReturn {
  /** All devices of the specified kind */
  devices: AudioDevice[];
  /** Audio input devices (microphones) */
  audioInputDevices: AudioDevice[];
  /** Audio output devices (speakers) */
  audioOutputDevices: AudioDevice[];
  /** Currently selected input device */
  selectedInputDevice: AudioDevice | null;
  /** Currently selected output device */
  selectedOutputDevice: AudioDevice | null;
  /** Whether devices are being loaded */
  isLoading: boolean;
  /** Error if any */
  error: Error | null;
  /** Whether permissions have been granted */
  hasPermissions: boolean;
  /** Select an input device */
  selectInputDevice: (deviceId: string) => void;
  /** Select an output device */
  selectOutputDevice: (deviceId: string) => void;
  /** Refresh the device list */
  refreshDevices: () => Promise<void>;
  /** Request microphone permissions */
  requestPermissions: () => Promise<boolean>;
}

/**
 * Convert MediaDeviceInfo to AudioDevice.
 */
function toAudioDevice(device: MediaDeviceInfo): AudioDevice {
  const isDefault = device.deviceId === 'default' || device.label.toLowerCase().includes('default');

  return {
    deviceId: device.deviceId,
    label: device.label || `${device.kind === 'audioinput' ? 'Microphone' : 'Speaker'} (${device.deviceId.slice(0, 8)})`,
    kind: device.kind as 'audioinput' | 'audiooutput',
    groupId: device.groupId,
    isDefault,
  };
}

/**
 * Hook for enumerating and selecting audio devices.
 *
 * @example
 * ```tsx
 * function DeviceSelector() {
 *   const {
 *     audioInputDevices,
 *     selectedInputDevice,
 *     selectInputDevice,
 *     hasPermissions,
 *     requestPermissions,
 *   } = useDevices();
 *
 *   if (!hasPermissions) {
 *     return (
 *       <button onClick={requestPermissions}>
 *         Grant Microphone Access
 *       </button>
 *     );
 *   }
 *
 *   return (
 *     <select
 *       value={selectedInputDevice?.deviceId ?? ''}
 *       onChange={(e) => selectInputDevice(e.target.value)}
 *     >
 *       {audioInputDevices.map((device) => (
 *         <option key={device.deviceId} value={device.deviceId}>
 *           {device.label}
 *         </option>
 *       ))}
 *     </select>
 *   );
 * }
 * ```
 */
export function useDevices(options: UseDevicesOptions = {}): UseDevicesReturn {
  const { requestPermissions: autoRequestPermissions = false, autoRefresh = true } = options;

  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState<string | null>(null);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [hasPermissions, setHasPermissions] = useState(false);

  // Enumerate devices
  const enumerateDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      setError(new Error('MediaDevices API not supported'));
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);

      const mediaDevices = await navigator.mediaDevices.enumerateDevices();

      const audioDevices = mediaDevices.filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput').map(toAudioDevice);

      setDevices(audioDevices);

      // Check if we have permissions (labels are available)
      const hasLabels = audioDevices.some((d) => d.label && !d.label.includes(d.deviceId.slice(0, 8)));
      setHasPermissions(hasLabels);

      // Auto-select default devices if none selected
      if (!selectedInputDeviceId) {
        const defaultInput = audioDevices.find((d) => d.kind === 'audioinput' && d.isDefault);
        if (defaultInput) {
          setSelectedInputDeviceId(defaultInput.deviceId);
        }
      }

      if (!selectedOutputDeviceId) {
        const defaultOutput = audioDevices.find((d) => d.kind === 'audiooutput' && d.isDefault);
        if (defaultOutput) {
          setSelectedOutputDeviceId(defaultOutput.deviceId);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [selectedInputDeviceId, selectedOutputDeviceId]);

  // Request permissions
  const requestPermissionsAsync = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop all tracks immediately
      stream.getTracks().forEach((track) => track.stop());
      setHasPermissions(true);
      // Refresh devices to get labels
      await enumerateDevices();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }, [enumerateDevices]);

  // Initial enumeration and auto-request permissions
  useEffect(() => {
    const init = async () => {
      await enumerateDevices();

      if (autoRequestPermissions && !hasPermissions) {
        await requestPermissionsAsync();
      }
    };

    init();
  }, [autoRequestPermissions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for device changes
  useEffect(() => {
    if (!autoRefresh || typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return;
    }

    const handleDeviceChange = () => {
      enumerateDevices();
    };

    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);

    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [autoRefresh, enumerateDevices]);

  // Derived state
  const audioInputDevices = useMemo(() => devices.filter((d) => d.kind === 'audioinput'), [devices]);
  const audioOutputDevices = useMemo(() => devices.filter((d) => d.kind === 'audiooutput'), [devices]);

  const selectedInputDevice = audioInputDevices.find((d) => d.deviceId === selectedInputDeviceId) ?? null;
  const selectedOutputDevice = audioOutputDevices.find((d) => d.deviceId === selectedOutputDeviceId) ?? null;

  // Select handlers
  const selectInputDevice = useCallback((deviceId: string) => {
    setSelectedInputDeviceId(deviceId);
  }, []);

  const selectOutputDevice = useCallback((deviceId: string) => {
    setSelectedOutputDeviceId(deviceId);
  }, []);

  return {
    devices,
    audioInputDevices,
    audioOutputDevices,
    selectedInputDevice,
    selectedOutputDevice,
    isLoading,
    error,
    hasPermissions,
    selectInputDevice,
    selectOutputDevice,
    refreshDevices: enumerateDevices,
    requestPermissions: requestPermissionsAsync,
  };
}
