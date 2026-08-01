import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileAudioSourceGroup, type FileAudioInput } from '../lib/file-audio-source';
// Type-only import — erased at compile time, so declaring the slice next to the
// other `Playground*Slice` interfaces in the context file creates no runtime
// import cycle with this hook.
import type { PlaygroundAudioSlice, PlaygroundAudioMode, PlaygroundAudioSource } from '../context/playground-session';

/**
 * Audio-source selection for the console (TASK-597 lane A).
 *
 * Owns the four capture modes and turns whichever is active into the exact
 * option bag `useAudioCapture` forwards to `audio.start(...)`:
 *
 * | mode          | what the SDK receives                                    |
 * |---------------|----------------------------------------------------------|
 * | `single-mic`  | `deviceId`                                               |
 * | `multi-mic`   | `deviceId` + `secondaryDeviceId` + `additionalDeviceIds`  |
 * | `file-single` | `sourceStreams: [oneFileStream]`                         |
 * | `file-multi`  | `sourceStreams: [n file streams]`                        |
 *
 * All four end up in the SAME mixer → noise-filter → VAD → STT graph — the
 * file modes are not a parallel code path, they are the same path fed from
 * `decodeAudioData` instead of `getUserMedia`.
 *
 * Called ONCE, by `<PlaygroundSessionProvider>`, above the tabs — the decoded
 * buffers and the live streams must survive a tab switch exactly like the mic.
 */
export function useAudioSources(): PlaygroundAudioSlice {
  const [mode, setModeState] = useState<PlaygroundAudioMode>('single-mic');

  // --- microphones ---------------------------------------------------------
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);

  // --- files ---------------------------------------------------------------
  const groupRef = useRef<FileAudioSourceGroup | null>(null);
  const [fileSources, setFileSources] = useState<{ id: string; label: string; stream: MediaStream }[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDecoding, setIsDecoding] = useState(false);
  const [splitStereo, setSplitStereo] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loop, setLoopState] = useState(false);
  const [rate, setRateState] = useState(1);

  // --- per-source gain, keyed by source id (deviceId or `file-N`) ----------
  const [gains, setGains] = useState<Record<string, number>>({});

  // ---------------------------------------------------------------------------
  // Device enumeration. Labels are BLANK until the user grants mic permission —
  // that blankness is the only signal the browser gives us, and it is what
  // `useAudioCapture().getDeviceStatus()` infers `permissionStatus` from too.
  // ---------------------------------------------------------------------------
  const refreshDevices = useCallback(async (): Promise<void> => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return;
    try {
      const all = await md.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'audioinput'));
    } catch {
      // An enumeration failure just leaves the list empty; the panel says so.
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<void> => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.getUserMedia) return;
    // Open and immediately release: we only want the permission grant, so the
    // labels become readable. Leaving this stream open would light the
    // recording indicator with nothing recording.
    const stream = await md.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    await refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    void refreshDevices();
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.addEventListener) return;
    const onChange = () => void refreshDevices();
    md.addEventListener('devicechange', onChange);
    return () => md.removeEventListener('devicechange', onChange);
  }, [refreshDevices]);

  const permissionStatus: 'granted' | 'prompt' = devices.some((d) => d.label) ? 'granted' : 'prompt';

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------
  const selectDevice = useCallback((deviceId: string) => {
    setSelectedDeviceIds([deviceId]);
  }, []);

  const toggleDevice = useCallback((deviceId: string) => {
    // Selection order IS mixer order (and therefore `mic 1`, `mic 2`, …), so a
    // toggled-on device appends rather than sorting into the device list order.
    setSelectedDeviceIds((prev) => (prev.includes(deviceId) ? prev.filter((id) => id !== deviceId) : [...prev, deviceId]));
  }, []);

  const setMode = useCallback((next: PlaygroundAudioMode) => {
    setModeState((prev) => {
      if (prev === next) return prev;
      // Narrowing multi → single keeps the first pick instead of silently
      // sending a multi-mic selection into a single-mic run.
      if (next === 'single-mic') setSelectedDeviceIds((ids) => ids.slice(0, 1));
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------------
  // File decoding + transport
  // ---------------------------------------------------------------------------
  const disposeGroup = useCallback(() => {
    groupRef.current?.dispose();
    groupRef.current = null;
    setFileSources([]);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, []);

  const loadFiles = useCallback(
    async (files: File[]): Promise<void> => {
      setFileError(null);
      if (files.length === 0) return;
      setIsDecoding(true);
      try {
        // `file-single` takes only the first file; `file-multi` maps each file
        // (or each channel of a stereo file) to its own virtual mic.
        const chosen = mode === 'file-single' ? files.slice(0, 1) : files;
        const inputs: FileAudioInput[] = chosen.map((file) => ({ file, splitStereo: mode === 'file-multi' && splitStereo }));
        const group = await FileAudioSourceGroup.create(inputs);
        groupRef.current?.dispose();
        groupRef.current = group;
        setFileSources(group.sources.map((s) => ({ id: s.id, label: s.label, stream: s.stream })));
        setDuration(group.duration);
        setCurrentTime(0);
        setIsPlaying(false);
      } catch (err) {
        setFileError(err instanceof Error ? err.message : 'Failed to decode the selected audio.');
      } finally {
        setIsDecoding(false);
      }
    },
    [mode, splitStereo],
  );

  const play = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    void group
      .play()
      .then(() => setIsPlaying(true))
      .catch((err: unknown) => setFileError(err instanceof Error ? err.message : 'Playback failed.'));
  }, []);

  const pause = useCallback(() => {
    const group = groupRef.current;
    if (!group) return;
    group.pause();
    setIsPlaying(false);
    setCurrentTime(group.currentTime);
  }, []);

  const seek = useCallback((seconds: number) => {
    const group = groupRef.current;
    if (!group) return;
    group.seek(seconds);
    setCurrentTime(group.currentTime);
  }, []);

  const setLoop = useCallback((next: boolean) => {
    setLoopState(next);
    groupRef.current?.setLoop(next);
  }, []);

  const setRate = useCallback((next: number) => {
    setRateState(next);
    groupRef.current?.setPlaybackRate(next);
  }, []);

  // Progress ticker — Web Audio exposes no timeupdate event, so poll while
  // playing (4 Hz is plenty for a seek bar and costs nothing).
  useEffect(() => {
    if (!isPlaying) return;
    const timer = setInterval(() => {
      const group = groupRef.current;
      if (!group) return;
      setCurrentTime(group.currentTime);
      if (!group.isPlaying) setIsPlaying(false);
    }, 250);
    return () => clearInterval(timer);
  }, [isPlaying]);

  // Release decoded buffers, streams, and the AudioContext on unmount.
  useEffect(() => () => disposeGroup(), [disposeGroup]);

  // ---------------------------------------------------------------------------
  // Resolved sources + the capture option bag
  // ---------------------------------------------------------------------------
  const isFileMode = mode === 'file-single' || mode === 'file-multi';

  const sources = useMemo<PlaygroundAudioSource[]>(() => {
    const entries = isFileMode
      ? fileSources.map((f) => ({ id: f.id, label: f.label }))
      : selectedDeviceIds.map((id) => ({
          id,
          label: devices.find((d) => d.deviceId === id)?.label || `Microphone ${id.slice(0, 8)}`,
        }));
    return entries.map((entry, index) => ({
      id: entry.id,
      // Ordinal, 1-based, in MIXER order — lane C tags metadata with exactly
      // this label, so it must stay stable for the life of a run.
      micLabel: `mic ${index + 1}`,
      sourceLabel: entry.label,
      gain: gains[entry.id] ?? 1,
    }));
  }, [isFileMode, fileSources, selectedDeviceIds, devices, gains]);

  const setGain = useCallback((id: string, gain: number) => {
    setGains((prev) => ({ ...prev, [id]: gain }));
  }, []);

  const captureOptions = useMemo<PlaygroundAudioSlice['captureOptions']>(() => {
    // Gains ride along only when at least one is off unity — a mixer with all
    // sources at 1.0 is exactly what the SDK does by default.
    const sourceGains = sources.map((s) => s.gain);
    const gainOption = sourceGains.some((g) => g !== 1) ? { sourceGains } : {};

    if (isFileMode) {
      const streams = fileSources.map((f) => f.stream);
      return streams.length > 0 ? { sourceStreams: streams, ...gainOption } : {};
    }
    const [primary, secondary, ...rest] = selectedDeviceIds;
    if (!primary) return {}; // nothing picked ⇒ the SDK opens the default mic
    return {
      deviceId: primary,
      ...(secondary ? { secondaryDeviceId: secondary } : {}),
      ...(rest.length > 0 ? { additionalDeviceIds: rest } : {}),
      ...gainOption,
    };
  }, [isFileMode, fileSources, selectedDeviceIds, sources]);

  return {
    mode,
    setMode,
    devices,
    permissionStatus,
    refreshDevices,
    requestPermission,
    selectedDeviceIds,
    selectDevice,
    toggleDevice,
    isDecoding,
    fileError,
    splitStereo,
    setSplitStereo,
    loadFiles,
    clearFiles: disposeGroup,
    playback: { isPlaying, currentTime, duration, loop, rate },
    play,
    pause,
    seek,
    setLoop,
    setRate,
    sources,
    setGain,
    captureOptions,
  };
}
