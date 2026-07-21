/**
 * @arcaai/vox - DualStreamRecorder
 *
 * Records a RAW track and a PROCESSED track in parallel via two MediaRecorders,
 * yielding one Blob per stream on stop. The consultation playground uses this to
 * persist both the unprocessed microphone and the noise-filtered/VAD-gated output
 * of the transcription pipeline from a single capture session.
 */

export interface DualStreamRecorderResult {
  raw: Blob;
  processed: Blob;
}

export interface DualStreamRecorderOptions {
  /** Container mime type for both recorders. Defaults to 'audio/webm'. */
  mimeType?: string;
  /** Optional timeslice (ms) passed to MediaRecorder.start for periodic chunks. */
  timesliceMs?: number;
}

const DEFAULT_MIME = 'audio/webm';

export class DualStreamRecorder {
  private rawRecorder: MediaRecorder | null = null;
  private processedRecorder: MediaRecorder | null = null;
  private rawChunks: Blob[] = [];
  private processedChunks: Blob[] = [];
  private readonly mimeType: string;
  private readonly timesliceMs?: number;
  private running = false;

  constructor(
    private readonly rawTrack: MediaStreamTrack,
    private readonly processedTrack: MediaStreamTrack,
    options: DualStreamRecorderOptions = {},
  ) {
    this.mimeType = options.mimeType ?? DEFAULT_MIME;
    this.timesliceMs = options.timesliceMs;
  }

  get isRecording(): boolean {
    return this.running;
  }

  /** Begin recording both tracks. No-op if already running. */
  start(): void {
    if (this.running) return;
    this.rawChunks = [];
    this.processedChunks = [];

    this.rawRecorder = this.makeRecorder(this.rawTrack, this.rawChunks);
    this.processedRecorder = this.makeRecorder(this.processedTrack, this.processedChunks);

    this.rawRecorder.start(this.timesliceMs);
    this.processedRecorder.start(this.timesliceMs);
    this.running = true;
  }

  /** Stop both recorders and resolve once each has flushed its final chunk. */
  async stop(): Promise<DualStreamRecorderResult> {
    if (!this.running || !this.rawRecorder || !this.processedRecorder) {
      throw new Error('DualStreamRecorder is not running');
    }

    const [raw, processed] = await Promise.all([
      this.stopOne(this.rawRecorder, this.rawChunks),
      this.stopOne(this.processedRecorder, this.processedChunks),
    ]);

    this.running = false;
    this.rawRecorder = null;
    this.processedRecorder = null;
    return { raw, processed };
  }

  private makeRecorder(track: MediaStreamTrack, sink: Blob[]): MediaRecorder {
    const stream = new MediaStream([track]);
    const recorder = this.isMimeSupported(this.mimeType) ? new MediaRecorder(stream, { mimeType: this.mimeType }) : new MediaRecorder(stream);
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) sink.push(event.data);
    };
    return recorder;
  }

  private stopOne(recorder: MediaRecorder, sink: Blob[]): Promise<Blob> {
    return new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(sink, { type: this.mimeType }));
      recorder.stop();
    });
  }

  private isMimeSupported(mimeType: string): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
      ? MediaRecorder.isTypeSupported(mimeType)
      : true;
  }
}
