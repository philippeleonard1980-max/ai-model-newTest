import type { VoiceSettings } from '@shared/types';

/**
 * Wraps the platform speech synthesiser (SAPI voices on Windows). Chosen over
 * a cloud TTS so replies start speaking immediately, work offline, and cost
 * nothing — the Gemini call is the only network round trip in a turn.
 */
export class Speaker {
  private utterance: SpeechSynthesisUtterance | null = null;
  private energyTimer: number | null = null;

  constructor(
    private readonly onEnergy: (level: number) => void,
    private readonly onStateChange: (speaking: boolean) => void,
  ) {}

  static voices(): SpeechSynthesisVoice[] {
    return window.speechSynthesis?.getVoices() ?? [];
  }

  /** Resolves once the browser has populated its voice list. */
  static async ready(timeoutMs = 3000): Promise<SpeechSynthesisVoice[]> {
    const synth = window.speechSynthesis;
    if (!synth) return [];
    if (synth.getVoices().length > 0) return synth.getVoices();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        synth.removeEventListener('voiceschanged', done);
        resolve(synth.getVoices());
      };
      const timer = setTimeout(done, timeoutMs);
      synth.addEventListener('voiceschanged', done);
    });
  }

  /**
   * Picks a voice for Rin: the user's explicit choice, else a female English
   * voice, else whatever English voice exists, else the system default.
   */
  static pickVoice(preferredUri: string | null, voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
    if (voices.length === 0) return null;
    if (preferredUri) {
      const exact = voices.find((voice) => voice.voiceURI === preferredUri);
      if (exact) return exact;
    }
    const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'));
    const pool = english.length > 0 ? english : voices;
    const feminine = pool.find((voice) =>
      /zira|hazel|aria|jenny|eva|female|samantha|susan|linda|sonia|natasha|clara/i.test(voice.name),
    );
    return feminine ?? pool[0] ?? null;
  }

  speak(text: string, settings: VoiceSettings, voices: SpeechSynthesisVoice[]): void {
    const synth = window.speechSynthesis;
    if (!synth || !text.trim()) return;
    this.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = Speaker.pickVoice(settings.voiceURI, voices);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.volume = settings.volume;

    utterance.onstart = () => {
      this.onStateChange(true);
      this.startEnergy();
    };
    const finish = (): void => {
      this.stopEnergy();
      this.onStateChange(false);
      this.utterance = null;
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    // Word boundaries give a real articulation pulse where the engine reports
    // them; the oscillator below covers engines that do not.
    utterance.onboundary = () => this.onEnergy(0.55 + Math.random() * 0.45);

    this.utterance = utterance;
    synth.speak(utterance);
  }

  private startEnergy(): void {
    this.stopEnergy();
    this.energyTimer = window.setInterval(() => {
      this.onEnergy(0.35 + Math.random() * 0.5);
    }, 90);
  }

  private stopEnergy(): void {
    if (this.energyTimer !== null) {
      clearInterval(this.energyTimer);
      this.energyTimer = null;
    }
    this.onEnergy(0);
  }

  cancel(): void {
    window.speechSynthesis?.cancel();
    this.stopEnergy();
    if (this.utterance) {
      this.utterance = null;
      this.onStateChange(false);
    }
  }

  get isSpeaking(): boolean {
    return Boolean(window.speechSynthesis?.speaking);
  }
}
