import type { VoiceSettings } from '@shared/types';

/**
 * Where spoken replies actually come out.
 *
 * Audio has to be produced on the side that owns the speaker, so unlike the
 * rest of the platform surface this is not an IPC call — each shell registers
 * its own backend at startup. Desktop uses the Windows SAPI voices exposed
 * through `window.speechSynthesis`; Android uses the native TextToSpeech
 * engine, because Android's WebView does not reliably implement Web Speech.
 */
export interface SpeechHandlers {
  onStart: () => void;
  onEnd: () => void;
  /** Fired per spoken word where the engine reports it; drives the mouth. */
  onBoundary: () => void;
}

export interface SpeechBackend {
  readonly name: string;
  listVoices(): Promise<SpeechSynthesisVoice[]>;
  speak(
    text: string,
    settings: VoiceSettings,
    voice: SpeechSynthesisVoice | null,
    handlers: SpeechHandlers,
  ): void;
  cancel(): void;
  /**
   * Subscribes to the voice list changing after startup. Returns an unsubscribe
   * function. Backends whose list is stable may return a no-op.
   */
  onVoicesChanged(listener: (voices: SpeechSynthesisVoice[]) => void): () => void;
}

/** The browser's own synthesiser — the default, and what the desktop app uses. */
export const webSpeechBackend: SpeechBackend = {
  name: 'web-speech',

  async listVoices(): Promise<SpeechSynthesisVoice[]> {
    const synth = window.speechSynthesis;
    if (!synth) return [];
    const now = synth.getVoices();
    if (now.length > 0) return now;
    // Voices populate asynchronously on first call.
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        synth.removeEventListener('voiceschanged', done);
        resolve(synth.getVoices());
      };
      const timer = setTimeout(done, 3000);
      synth.addEventListener('voiceschanged', done);
    });
  },

  speak(text, settings, voice, handlers): void {
    const synth = window.speechSynthesis;
    if (!synth) {
      handlers.onEnd();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.volume = settings.volume;
    utterance.onstart = () => handlers.onStart();
    utterance.onend = () => handlers.onEnd();
    utterance.onerror = () => handlers.onEnd();
    utterance.onboundary = () => handlers.onBoundary();
    synth.speak(utterance);
  },

  cancel(): void {
    window.speechSynthesis?.cancel();
  },

  onVoicesChanged(listener): () => void {
    const synth = window.speechSynthesis;
    if (!synth) return () => undefined;
    // Windows enumerates SAPI voices asynchronously and can finish well after
    // startup, so this stays subscribed for the session.
    const handler = (): void => {
      const voices = synth.getVoices();
      if (voices.length > 0) listener(voices);
    };
    synth.addEventListener('voiceschanged', handler);
    return () => synth.removeEventListener('voiceschanged', handler);
  },
};

let active: SpeechBackend = webSpeechBackend;

/** Called once at startup by a shell that needs something other than the default. */
export function setSpeechBackend(backend: SpeechBackend): void {
  active = backend;
}

export function speechBackend(): SpeechBackend {
  return active;
}
