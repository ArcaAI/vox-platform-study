/**
 * @arcaai/vad - Basic Usage Example
 *
 * This example demonstrates basic VAD integration with @arcaai/room.
 */

import React from 'react';
import { RoomProvider, useAudioTrack, useAudioLevel } from '@arcaai/room';
import { useVAD } from '@arcaai/vad';

/**
 * Main application component with RoomProvider.
 */
export function App() {
  return (
    <RoomProvider>
      <VoiceRecorder />
    </RoomProvider>
  );
}

/**
 * Voice recorder component with VAD integration.
 */
function VoiceRecorder() {
  const { track, isCapturing, startCapture, stopCapture, isMuted, toggleMute } =
    useAudioTrack({
      noiseSuppression: true,
      echoCancellation: true,
    });

  const { level } = useAudioLevel(track);

  const {
    isSpeaking,
    speechProbability,
    stats,
    isActive,
    error,
  } = useVAD({
    track,
    model: 'v5',
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    minSpeechMs: 250,
    preSpeechPadMs: 300,
    enableStats: true,
    autoAttach: true,
    onSpeechStart: () => {
      console.log('[VAD] Speech started');
    },
    onSpeechEnd: (audio) => {
      console.log('[VAD] Speech ended:', {
        samples: audio.length,
        duration: (audio.length / 16000) * 1000,
      });
      // Here you would send `audio` to your transcription service
    },
    onVADMisfire: () => {
      console.log('[VAD] Misfire - speech too short');
    },
  });

  return (
    <div style={styles.container}>
      <h1>Voice Activity Detection Demo</h1>

      {error && (
        <div style={styles.error}>
          Error: {error.message}
        </div>
      )}

      <div style={styles.controls}>
        <button
          onClick={isCapturing ? stopCapture : startCapture}
          style={styles.button}
        >
          {isCapturing ? '⏹️ Stop' : '▶️ Start'}
        </button>

        <button
          onClick={toggleMute}
          disabled={!isCapturing}
          style={styles.button}
        >
          {isMuted ? '🔇 Unmute' : '🔊 Mute'}
        </button>
      </div>

      <div style={styles.status}>
        <StatusRow label="Recording" value={isCapturing ? 'Yes' : 'No'} />
        <StatusRow label="VAD Active" value={isActive ? 'Yes' : 'No'} />
        <StatusRow
          label="Speaking"
          value={isSpeaking ? '🎤 Yes' : '⏸️ No'}
          highlight={isSpeaking}
        />
        <StatusRow
          label="Probability"
          value={`${(speechProbability * 100).toFixed(1)}%`}
        />
        <StatusRow
          label="Audio Level"
          value={`${(level * 100).toFixed(0)}%`}
        />
      </div>

      {stats && (
        <div style={styles.stats}>
          <h3>Statistics</h3>
          <StatRow label="Frames Processed" value={stats.framesProcessed} />
          <StatRow label="Speech Segments" value={stats.speechSegmentsDetected} />
          <StatRow label="Misfires" value={stats.misfireCount} />
          <StatRow
            label="Avg Probability"
            value={`${(stats.averageSpeechProbability * 100).toFixed(1)}%`}
          />
        </div>
      )}

      <div style={styles.visualizer}>
        <div
          style={{
            ...styles.probabilityBar,
            width: `${speechProbability * 100}%`,
            backgroundColor: isSpeaking ? '#4CAF50' : '#2196F3',
          }}
        />
      </div>
    </div>
  );
}

// Helper components
function StatusRow({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div style={{ ...styles.statusRow, fontWeight: highlight ? 'bold' : 'normal' }}>
      <span>{label}:</span>
      <span>{value}</span>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={styles.statRow}>
      <span>{label}:</span>
      <span>{value}</span>
    </div>
  );
}

// Styles
const styles: Record<string, React.CSSProperties> = {
  container: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth: '600px',
    margin: '0 auto',
    padding: '20px',
  },
  error: {
    backgroundColor: '#ffebee',
    color: '#c62828',
    padding: '10px',
    borderRadius: '4px',
    marginBottom: '20px',
  },
  controls: {
    display: 'flex',
    gap: '10px',
    marginBottom: '20px',
  },
  button: {
    padding: '10px 20px',
    fontSize: '16px',
    cursor: 'pointer',
    border: '1px solid #ccc',
    borderRadius: '4px',
    backgroundColor: '#fff',
  },
  status: {
    backgroundColor: '#f5f5f5',
    padding: '15px',
    borderRadius: '8px',
    marginBottom: '20px',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '5px 0',
  },
  stats: {
    backgroundColor: '#e3f2fd',
    padding: '15px',
    borderRadius: '8px',
    marginBottom: '20px',
  },
  statRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '3px 0',
    fontSize: '14px',
  },
  visualizer: {
    height: '30px',
    backgroundColor: '#e0e0e0',
    borderRadius: '15px',
    overflow: 'hidden',
  },
  probabilityBar: {
    height: '100%',
    transition: 'width 0.1s, background-color 0.2s',
    borderRadius: '15px',
  },
};

export default App;
