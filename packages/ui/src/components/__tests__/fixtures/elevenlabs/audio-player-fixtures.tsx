import {
  AudioPlayerProvider,
  AudioPlayerButton,
  AudioPlayerProgress,
  AudioPlayerTime,
  AudioPlayerDuration,
  AudioPlayerSpeed,
  AudioPlayerSpeedButtonGroup,
  exampleTracks,
} from '../../../elevenlabs/audio-player';

const defaultTrack = {
  id: exampleTracks[0].id,
  src: exampleTracks[0].url,
};

export function BasicAudioPlayer() {
  return (
    <AudioPlayerProvider>
      <div data-testid="audio-player" className="flex items-center gap-3">
        <AudioPlayerButton item={defaultTrack} variant="outline" size="icon" data-testid="play-button" />
        <AudioPlayerTime data-testid="current-time" />
        <AudioPlayerProgress className="flex-1" data-testid="progress" />
        <AudioPlayerDuration data-testid="duration" />
      </div>
    </AudioPlayerProvider>
  );
}

export function AudioPlayerWithSpeed() {
  return (
    <AudioPlayerProvider>
      <div data-testid="audio-player" className="flex items-center gap-3">
        <AudioPlayerButton item={defaultTrack} variant="outline" size="icon" data-testid="play-button" />
        <AudioPlayerProgress className="flex-1" />
        <AudioPlayerSpeed data-testid="speed-control" />
      </div>
    </AudioPlayerProvider>
  );
}

export function AudioPlayerWithSpeedButtons() {
  return (
    <AudioPlayerProvider>
      <div data-testid="audio-player" className="flex flex-col gap-3">
        <AudioPlayerButton item={defaultTrack} variant="outline" size="icon" data-testid="play-button" />
        <AudioPlayerSpeedButtonGroup data-testid="speed-buttons" />
      </div>
    </AudioPlayerProvider>
  );
}

export function MultiTrackPlayer() {
  return (
    <AudioPlayerProvider>
      <div data-testid="audio-player" className="space-y-2">
        {exampleTracks.slice(0, 3).map((track) => (
          <div key={track.id} data-testid={`track-${track.id}`}>
            <AudioPlayerButton item={{ id: track.id, src: track.url }} variant="ghost" size="icon" data-testid={`play-${track.id}`} />
            <span>{track.name}</span>
          </div>
        ))}
      </div>
    </AudioPlayerProvider>
  );
}
