import { cn } from '@/lib/utils';
import { useAudioStore, type MicrophoneSource } from '@/store/audio-store';
import { useBrowserCapabilities } from '@arcaai/room';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Separator } from '@arcaai/ui/separator';
import { Mic, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

function hasPermissionGrantedDevices(devices: MediaDeviceInfo[]): boolean {
  return devices.some((d) => d.kind === 'audioinput' && d.deviceId.trim().length > 0 && d.label.length > 0);
}

export function AudioSourcePanel() {
  const { sources, isCapturing, addMicrophoneSource, removeMicrophoneSource, clearSources } = useAudioStore();

  const { supportsMultipleMics } = useBrowserCapabilities();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [requestingPermission, setRequestingPermission] = useState(false);

  const refreshDevices = useCallback(async () => {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = allDevices.filter((d) => d.kind === 'audioinput');
      setDevices(audioInputs);
      if (hasPermissionGrantedDevices(allDevices)) {
        setPermissionGranted(true);
      }
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    let disposed = false;

    async function loadDevices() {
      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        if (disposed) return;
        const audioInputs = allDevices.filter((d) => d.kind === 'audioinput');
        setDevices(audioInputs);
        if (hasPermissionGrantedDevices(allDevices)) {
          setPermissionGranted(true);
        } else {
          // Auto-request mic permission on first load
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((t) => t.stop());
            if (disposed) return;
            setPermissionGranted(true);
            const refreshed = await navigator.mediaDevices.enumerateDevices();
            if (disposed) return;
            setDevices(refreshed.filter((d) => d.kind === 'audioinput'));
          } catch {
            // Permission denied or dismissed - user can retry via button
          }
        }
      } catch {
        if (!disposed) setDevices([]);
      }
    }
    loadDevices();

    const handler = () => {
      navigator.mediaDevices.enumerateDevices().then((all) => {
        if (disposed) return;
        setDevices(all.filter((d) => d.kind === 'audioinput'));
        if (hasPermissionGrantedDevices(all)) {
          setPermissionGranted(true);
        }
      });
    };
    navigator.mediaDevices.addEventListener('devicechange', handler);
    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener('devicechange', handler);
    };
  }, [isCapturing]);

  const requestMicPermission = useCallback(async () => {
    setRequestingPermission(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setPermissionGranted(true);
      await refreshDevices();
      toast.success('Microphone permission granted');
    } catch {
      toast.error('Microphone permission denied. Check browser settings.');
    } finally {
      setRequestingPermission(false);
    }
  }, [refreshDevices]);

  const micSources = sources.filter((s): s is MicrophoneSource => s.type === 'microphone');

  const availableDevices = permissionGranted
    ? devices.filter((d) => d.deviceId.trim().length > 0).filter((d) => !micSources.some((src) => src.deviceId === d.deviceId))
    : micSources.length === 0
      ? [{ deviceId: '', label: 'System default microphone', kind: 'audioinput' as const }]
      : [];

  const handleAddMic = useCallback(
    (selectedValue: string) => {
      if (selectedValue === '__default__' || !permissionGranted) {
        addMicrophoneSource('', 'System default microphone');
        toast.success('Added system default microphone');
        return;
      }
      const device = devices.find((d) => d.deviceId === selectedValue);
      const label = device?.label || `Microphone ${selectedValue.slice(0, 8)}`;
      addMicrophoneSource(selectedValue, label);
      toast.success(`Added ${label}`);
    },
    [permissionGranted, devices, addMicrophoneSource],
  );

  return (
    <Card data-doc="mic-sources">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mic className="size-4" />
            <CardTitle className="text-sm">Microphone Sources</CardTitle>
          </div>
          {micSources.length > 0 && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={clearSources} disabled={isCapturing}>
              <X className="size-3" /> Clear All
            </Button>
          )}
        </div>
        <CardDescription className="text-xs">Select microphones for real-time live transcription</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Separator />
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs font-medium">Microphones</span>
            <div className="flex items-center gap-1">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="sm" className="cursor-pointer size-6 p-0" onClick={requestMicPermission} disabled={requestingPermission}>
                      <ShieldCheck className={cn('size-3.5', requestingPermission ? 'animate-pulse' : permissionGranted ? 'text-emerald-500' : 'text-muted-foreground')} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">{permissionGranted ? 'Microphone access granted. Click to refresh devices.' : 'Microphone unavailable. Click to allow access.'}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Badge variant="outline" className="text-[10px]">
              {micSources.length} selected
            </Badge>
            </div>
          </div>
          {availableDevices.length > 0 && (
            <Select onValueChange={handleAddMic} disabled={isCapturing || (!supportsMultipleMics && micSources.length >= 1)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Add microphone..." />
              </SelectTrigger>
              <SelectContent>
                {availableDevices.map((device, index) => (
                  <SelectItem key={device.deviceId || `default-${index}`} value={device.deviceId || '__default__'}>
                    <span className="flex items-center gap-2">
                      <Plus className="size-3" />
                      {device.label || `Mic ${device.deviceId.slice(0, 8)}`}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {!supportsMultipleMics && micSources.length >= 1 && availableDevices.length > 0 && (
            <p className="text-muted-foreground text-[10px]">Multi-microphone capture is not available in this browser.</p>
          )}
          {micSources.length > 0 && (
            <div className="space-y-1.5">
              {micSources.map((src) => (
                <div key={src.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Mic className="text-primary size-3.5 shrink-0" />
                    <span className="truncate text-xs">{src.label}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-6 p-0 shrink-0"
                    onClick={() => removeMicrophoneSource(src.id)}
                    disabled={isCapturing}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {devices.length === 0 && <p className="text-muted-foreground text-[11px]">No microphones detected. Check browser permissions.</p>}
        </div>
      </CardContent>
    </Card>
  );
}
