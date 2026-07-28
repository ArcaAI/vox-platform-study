/**
 * @arcaai/vad - Transcription Integration Example
 *
 * This example demonstrates how to integrate VAD with a transcription service.
 */

import { AudioTrack, AudioContextManager, Room } from '@arcaai/room';
import { VADProcessor, downsampleTo16kHz, VAD_SAMPLE_RATE } from '@arcaai/vad';

/**
 * Example transcription service interface.
 */
interface TranscriptionService {
  transcribe(audio: Float32Array, sampleRate: number): Promise<string>;
}

/**
 * Mock transcription service for demonstration.
 */
const mockTranscriptionService: TranscriptionService = {
  async transcribe(audio: Float32Array, sampleRate: number): Promise<string> {
    // In a real implementation, you would send this to your API
    console.log(`[Transcription] Received ${audio.length} samples at ${sampleRate}Hz`);
    console.log(`[Transcription] Duration: ${(audio.length / sampleRate) * 1000}ms`);

    // Simulate API latency
    await new Promise((resolve) => setTimeout(resolve, 500));

    return `[Transcribed text would appear here - ${audio.length} samples]`;
  },
};

/**
 * Main function to set up VAD with transcription.
 */
async function setupVADWithTranscription() {
  console.log('[Setup] Initializing VAD with transcription...');

  // Create room and connect
  const room = new Room({ webAudioMix: true });
  await room.connect();

  // Create audio track
  const track = await room.createLocalTrack({
    noiseSuppression: true,
    echoCancellation: true,
  });

  console.log('[Setup] Audio track created');

  // Transcript storage
  const transcripts: Array<{
    timestamp: number;
    text: string;
    duration: number;
  }> = [];

  // Create VAD processor with transcription integration
  const vad = new VADProcessor({
    model: 'v5',
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    minSpeechMs: 300, // Slightly higher to avoid very short segments
    preSpeechPadMs: 300,
    postSpeechPadMs: 300,
    enableStats: true,
    statsInterval: 5000,
  });

  // Handle speech events
  vad.on('data', async (payload) => {
    switch (payload.type) {
      case 'vad-speech-start':
        console.log('[VAD] Speech started');
        break;

      case 'vad-speech-end': {
        const { audio, startTime, endTime, duration } = payload.data as {
          audio: Float32Array;
          startTime: number;
          endTime: number;
          duration: number;
        };

        console.log(`[VAD] Speech ended - ${duration}ms`);

        // The audio from VAD is already at 16kHz
        try {
          const text = await mockTranscriptionService.transcribe(audio, VAD_SAMPLE_RATE);

          transcripts.push({
            timestamp: startTime,
            text,
            duration,
          });

          console.log(`[Transcript] ${text}`);
        } catch (error) {
          console.error('[Transcription] Error:', error);
        }
        break;
      }

      case 'vad-misfire':
        console.log('[VAD] Misfire - speech too short');
        break;

      case 'vad-stats': {
        const stats = payload.data as {
          framesProcessed: number;
          speechSegmentsDetected: number;
          averageSpeechProbability: number;
        };
        console.log('[VAD Stats]', {
          frames: stats.framesProcessed,
          segments: stats.speechSegmentsDetected,
          avgProbability: `${(stats.averageSpeechProbability * 100).toFixed(1)}%`,
        });
        break;
      }
    }
  });

  // Attach VAD to track
  await track.setProcessor(vad);
  console.log('[Setup] VAD processor attached');

  // Return cleanup function and data access
  return {
    room,
    track,
    vad,
    transcripts,
    getTranscripts: () => [...transcripts],
    stop: async () => {
      console.log('[Cleanup] Stopping...');
      await track.stop();
      await room.disconnect();
      console.log('[Cleanup] Done');
    },
  };
}

/**
 * Example: Processing audio buffer with VAD.
 */
async function processAudioBuffer(audioBuffer: Float32Array, inputSampleRate: number): Promise<void> {
  console.log('[Process] Processing audio buffer...');
  console.log(`[Process] Input: ${audioBuffer.length} samples at ${inputSampleRate}Hz`);

  // Resample to 16kHz if needed
  const resampledAudio = inputSampleRate === VAD_SAMPLE_RATE ? audioBuffer : downsampleTo16kHz(audioBuffer, inputSampleRate);

  console.log(`[Process] Resampled: ${resampledAudio.length} samples at 16kHz`);

  // Now you can use this with NonRealTimeVAD if needed
  // For real-time processing, use VADProcessor as shown above
}

// Example usage
export { setupVADWithTranscription, processAudioBuffer };

// Run example if executed directly
if (typeof window !== 'undefined') {
  console.log('VAD Transcription Integration Example');
  console.log('Call setupVADWithTranscription() to start');
}
