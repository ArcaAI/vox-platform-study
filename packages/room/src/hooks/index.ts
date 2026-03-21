/**
 * @arcaai/room - Hooks Module
 *
 * React hooks for audio management.
 */

export { useRoom, useRoomSafe, type RoomContextValue } from './useRoom.js';

export {
  useAudioTrack,
  type UseAudioTrackOptions,
  type UseAudioTrackReturn,
} from './useAudioTrack.js';

export {
  useProcessors,
  type UseProcessorsOptions,
  type UseProcessorsReturn,
} from './useProcessors.js';

export {
  useAudioLevel,
  useMediaStreamAudioLevel,
  type UseAudioLevelOptions,
  type UseAudioLevelReturn,
} from './useAudioLevel.js';

export {
  useDevices,
  type UseDevicesOptions,
  type UseDevicesReturn,
  type DeviceKind,
} from './useDevices.js';

export {
  useBrowserCapabilities,
  type UseBrowserCapabilitiesReturn,
} from './useBrowserCapabilities.js';

export {
  useAudioMixer,
  type UseAudioMixerReturn,
} from './useAudioMixer.js';
