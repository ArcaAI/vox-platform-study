import { STORAGE_KEYS } from '@/lib/constants';
import { getLocalStorage, setLocalStorage } from '@/lib/local-storage';

type SpeakerRoute = 'live' | 'job' | 'local';

export interface SpeakerVoiceFeaturesInput {
  source?: string;
  vector?: number[];
  profileSamples?: number;
  similarity?: number;
  sampleRate?: number;
}

export interface SpeakerObservation {
  route: SpeakerRoute;
  speakerId?: string;
  speakerLabel?: string;
  speakerConfidence?: number;
  startTime?: number;
  endTime?: number;
  text?: string;
  features?: SpeakerVoiceFeaturesInput;
}

export interface StoredSpeakerProfile {
  speakerId: string;
  label: string;
  firstSeenAt: number;
  lastSeenAt: number;
  segmentCount: number;
  averageConfidence?: number;
  lastRoute: SpeakerRoute;
  lastText?: string;
  lastStartTime?: number;
  lastEndTime?: number;
  features?: SpeakerVoiceFeaturesInput;
}

interface SpeakerProfileStorage {
  version: 1;
  updatedAt: number;
  profiles: Record<string, StoredSpeakerProfile>;
}

const STORAGE_KEY = `${STORAGE_KEYS.AUDIO_CONFIG}.speakerRecognition.v1`;
const MAX_PROFILES = 64;

function formatSpeakerLabel(speakerId: string): string {
  const trimmed = speakerId.trim();
  if (!trimmed) return 'Unknown';
  if (trimmed.toLowerCase() === 'unknown') return 'Unknown';

  const match = trimmed.match(/^speaker[-_\s]?(\d+)$/i);
  if (match?.[1]) {
    return `Speaker ${match[1]}`;
  }
  return trimmed;
}

function sanitizeConfidence(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readStorage(): SpeakerProfileStorage {
  const raw = getLocalStorage(STORAGE_KEY);
  if (!raw) {
    return { version: 1, updatedAt: Date.now(), profiles: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SpeakerProfileStorage>;
    if (parsed?.version !== 1 || typeof parsed.profiles !== 'object' || !parsed.profiles) {
      return { version: 1, updatedAt: Date.now(), profiles: {} };
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      profiles: parsed.profiles as Record<string, StoredSpeakerProfile>,
    };
  } catch {
    return { version: 1, updatedAt: Date.now(), profiles: {} };
  }
}

function writeStorage(state: SpeakerProfileStorage): void {
  setLocalStorage(STORAGE_KEY, JSON.stringify(state));
}

function trimProfiles(profiles: Record<string, StoredSpeakerProfile>): Record<string, StoredSpeakerProfile> {
  const entries = Object.entries(profiles);
  if (entries.length <= MAX_PROFILES) {
    return profiles;
  }

  const sorted = entries.sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt);
  const next: Record<string, StoredSpeakerProfile> = {};
  for (const [key, profile] of sorted.slice(0, MAX_PROFILES)) {
    next[key] = profile;
  }
  return next;
}

export function resolveSpeakerLabel(speakerId?: string, speakerLabel?: string): string | undefined {
  if (speakerLabel && speakerLabel.trim().length > 0) return speakerLabel.trim();
  if (!speakerId || speakerId.trim().length === 0) return undefined;

  const storage = readStorage();
  const existing = storage.profiles[speakerId];
  if (existing?.label) {
    return existing.label;
  }
  return formatSpeakerLabel(speakerId);
}

export function recordSpeakerObservation(observation: SpeakerObservation): StoredSpeakerProfile | null {
  const speakerId = observation.speakerId?.trim();
  if (!speakerId) return null;

  const now = Date.now();
  const storage = readStorage();
  const existing = storage.profiles[speakerId];
  const confidence = sanitizeConfidence(observation.speakerConfidence);
  const label = observation.speakerLabel?.trim() || existing?.label || formatSpeakerLabel(speakerId);

  const segmentCount = (existing?.segmentCount ?? 0) + 1;
  const previousAvg = existing?.averageConfidence;
  const averageConfidence =
    confidence == null ? previousAvg : previousAvg == null ? confidence : (previousAvg * (segmentCount - 1) + confidence) / segmentCount;

  const profile: StoredSpeakerProfile = {
    speakerId,
    label,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    segmentCount,
    averageConfidence,
    lastRoute: observation.route,
    lastText: observation.text ? observation.text.slice(0, 160) : existing?.lastText,
    lastStartTime: observation.startTime ?? existing?.lastStartTime,
    lastEndTime: observation.endTime ?? existing?.lastEndTime,
    features: observation.features ?? existing?.features,
  };

  storage.profiles[speakerId] = profile;
  storage.profiles = trimProfiles(storage.profiles);
  storage.updatedAt = now;
  writeStorage(storage);
  return profile;
}
