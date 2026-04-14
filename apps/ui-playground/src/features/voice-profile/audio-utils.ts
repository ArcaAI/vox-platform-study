// ---------------------------------------------------------------------------
// Audio sample types & utilities for voice profile enrollment
// ---------------------------------------------------------------------------

export interface AudioSample {
  id: string;
  name: string;
  blob: Blob;
  duration: number;
}

export const MAX_SAMPLE_DURATION = 10;
export const MAX_SAMPLES = 3;

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export async function getAudioDuration(blob: Blob): Promise<number> {
  const ctx = new AudioContext();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    return audioBuffer.duration;
  } finally {
    await ctx.close();
  }
}

export async function toWavFile(blob: Blob, name: string): Promise<File> {
  const ctx = new AudioContext();
  try {
    const ab = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(ab);
    const sampleRate = audioBuffer.sampleRate;
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;

    const mono = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (let ch = 0; ch < channels; ch++) {
        sample += audioBuffer.getChannelData(ch)[i];
      }
      mono[i] = sample / channels;
    }

    const bytesPerSample = 2;
    const dataSize = mono.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    let off = 44;
    for (let i = 0; i < mono.length; i++) {
      const s = Math.max(-1, Math.min(1, mono[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }

    return new File([buffer], name, { type: 'audio/wav' });
  } finally {
    await ctx.close();
  }
}
