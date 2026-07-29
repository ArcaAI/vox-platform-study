import {
  TranscriptViewerContainer,
  TranscriptViewerWords,
  TranscriptViewerAudio,
  TranscriptViewerPlayPauseButton,
  TranscriptViewerScrubBar,
} from '../../../elevenlabs/transcript-viewer';

const mockAlignment = {
  characters: ['H', 'e', 'l', 'l', 'o'],
  character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4],
  character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5],
  characterStartTimesSeconds: [0, 0.1, 0.2, 0.3, 0.4],
  characterEndTimesSeconds: [0.1, 0.2, 0.3, 0.4, 0.5],
};

export function BasicTranscriptViewer() {
  return (
    <TranscriptViewerContainer
      audioSrc="https://storage.googleapis.com/eleven-public-cdn/audio/ui-elevenlabs-io/00.mp3"
      audioType="audio/mpeg"
      alignment={mockAlignment}
    >
      <TranscriptViewerAudio />
      <TranscriptViewerWords />
      <div className="flex items-center gap-3">
        <TranscriptViewerPlayPauseButton data-testid="play-pause" />
        <TranscriptViewerScrubBar className="flex-1" />
      </div>
    </TranscriptViewerContainer>
  );
}

export function TranscriptViewerPlayOnly() {
  return (
    <TranscriptViewerContainer
      audioSrc="https://storage.googleapis.com/eleven-public-cdn/audio/ui-elevenlabs-io/00.mp3"
      audioType="audio/mpeg"
      alignment={mockAlignment}
    >
      <TranscriptViewerAudio />
      <TranscriptViewerPlayPauseButton data-testid="play-pause" />
    </TranscriptViewerContainer>
  );
}
