/**
 * Push-to-talk capture. Records from the default microphone and hands the raw
 * bytes back, which the main process forwards to Gemini for transcription —
 * so speech recognition needs no extra service or credential.
 */
export interface Recording {
  audio: ArrayBuffer;
  mimeType: string;
  durationMs: number;
}

/** Codecs Chromium can produce, best first; Gemini accepts all of these. */
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function pickMimeType(): string {
  for (const type of PREFERRED_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export class PushToTalkRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private analyser: AnalyserNode | null = null;
  private audioContext: AudioContext | null = null;
  private levelTimer: number | null = null;

  constructor(private readonly onLevel?: (level: number) => void) {}

  get isRecording(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(): Promise<void> {
    if (this.isRecording) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.startedAt = performance.now();
    this.recorder.start();
    this.startMeter();
  }

  /** Stops recording and resolves with the captured audio, or null if empty. */
  async stop(): Promise<Recording | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      this.cleanup();
      return null;
    }

    const finished = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
    });
    recorder.stop();
    await finished;

    const durationMs = performance.now() - this.startedAt;
    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type: mimeType });
    this.cleanup();

    // Anything this short is a mis-click rather than speech.
    if (blob.size === 0 || durationMs < 250) return null;
    return { audio: await blob.arrayBuffer(), mimeType, durationMs };
  }

  /** Aborts without producing a recording. */
  abort(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.cleanup();
  }

  private startMeter(): void {
    if (!this.onLevel || !this.stream) return;
    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);

      const buffer = new Uint8Array(this.analyser.frequencyBinCount);
      this.levelTimer = window.setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(buffer);
        let sum = 0;
        for (const sample of buffer) {
          const centred = (sample - 128) / 128;
          sum += centred * centred;
        }
        const rms = Math.sqrt(sum / buffer.length);
        this.onLevel?.(Math.min(1, rms * 4));
      }, 60);
    } catch {
      // The level meter is decoration; recording continues without it.
    }
  }

  private cleanup(): void {
    if (this.levelTimer !== null) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    this.onLevel?.(0);
    this.analyser = null;
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}
