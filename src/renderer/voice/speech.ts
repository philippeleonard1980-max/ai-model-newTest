import type { VoiceSettings } from '@shared/types';
import { speechBackend } from './backend';

/**
 * Speaks Rin's replies and reports a crude loudness envelope so the avatar's
 * mouth can move in time. The actual synthesiser is whatever backend the shell
 * registered — Windows SAPI on desktop, native TextToSpeech on Android.
 */
export class Speaker {
  private speaking = false;
  private energyTimer: number | null = null;

  constructor(
    private readonly onEnergy: (level: number) => void,
    private readonly onStateChange: (speaking: boolean) => void,
  ) {}

  /** Resolves once the platform has enumerated its voices. */
  static async ready(): Promise<SpeechSynthesisVoice[]> {
    try {
      return await speechBackend().listVoices();
    } catch {
      return [];
    }
  }

  /**
   * Picks a voice for Rin: the user's explicit choice, else a female English
   * voice, else whatever English voice exists, else the system default.
   */
  static pickVoice(
    preferredUri: string | null,
    voices: SpeechSynthesisVoice[],
  ): SpeechSynthesisVoice | null {
    if (voices.length === 0) return null;
    if (preferredUri) {
      const exact = voices.find((voice) => voice.voiceURI === preferredUri);
      if (exact) return exact;
    }
    const english = voices.filter((voice) => voice.lang?.toLowerCase().startsWith('en'));
    const pool = english.length > 0 ? english : voices;
    const feminine = pool.find((voice) =>
      /zira|hazel|aria|jenny|eva|female|samantha|susan|linda|sonia|natasha|clara/i.test(voice.name),
    );
    return feminine ?? pool[0] ?? null;
  }

  speak(text: string, settings: VoiceSettings, voices: SpeechSynthesisVoice[]): void {
    if (!text.trim()) return;
    this.cancel();

    const voice = Speaker.pickVoice(settings.voiceURI, voices);
    speechBackend().speak(text, settings, voice, {
      onStart: () => {
        this.speaking = true;
        this.onStateChange(true);
        this.startEnergy();
      },
      onEnd: () => {
        this.stopEnergy();
        this.speaking = false;
        this.onStateChange(false);
      },
      // A real articulation pulse where the engine reports word boundaries;
      // the oscillator below covers engines that do not.
      onBoundary: () => this.onEnergy(0.55 + Math.random() * 0.45),
    });
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
    speechBackend().cancel();
    this.stopEnergy();
    if (this.speaking) {
      this.speaking = false;
      this.onStateChange(false);
    }
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }
}
