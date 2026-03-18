## Microphone Sources

Select which microphone devices to use for live transcription. Multiple microphones can be added and managed from this panel.

<!-- @section -->

### How It Works

1. Available audio input devices are listed via `enumerateDevices()`
2. Select a device from the dropdown to add it as a source
3. The list updates automatically when a microphone is plugged in or unplugged
4. Before permissions are granted, a "System default microphone" option is shown

<!-- @example -->

```tsx
import { useAudioTrack } from '@arcaai/room';

// Open a mic stream by device ID
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { deviceId: { exact: selectedDeviceId } },
});
```

<!-- @/example -->
<!-- @/section -->

### Features

- **Add multiple microphones** – Select different devices from the dropdown (browser support required)
- **Remove individual sources** – Click the trash icon next to any added microphone
- **Clear all** – Remove all microphone sources at once
- **Permission-aware** – Shows labeled device names once browser permission is granted

### Behavior

- Adding or removing sources is disabled while actively capturing audio.
- Adding 2+ microphones enables the Audio Mixer panel for per-channel gain control.
- Some browsers only support a single simultaneous mic capture; the panel restricts to one device when this is detected.

### Tips

- Grant microphone permissions early to see labeled device names.
- If a device does not appear, check browser permissions in system settings.
