import { TextToSpeech } from '@capacitor-community/text-to-speech';
import type { PluginListenerHandle } from '@capacitor/core';
import type { SpeechBackend } from '../renderer/voice/backend';

/**
 * Android speech. The system WebView does not reliably implement Web Speech
 * synthesis, so replies go through the platform TextToSpeech engine instead.
 *
 * The plugin reports word ranges through `onRangeStart`, which stands in for
 * the web API's `onboundary` and drives the avatar's mouth just as well.
 */
export const capacitorTtsBackend: SpeechBackend = {
  name: 'capacitor-tts',

  async listVoices(): Promise<SpeechSynthesisVoice[]> {
    try {
      const { voices } = await TextToSpeech.getSupportedVoices();
      return voices;
    } catch {
      return [];
    }
  },

  speak(text, settings, voice, handlers): void {
    void (async () => {
      let listener: PluginListenerHandle | null = null;
      try {
        // The plugin selects a voice by index into the list it reported.
        let voiceIndex: number | undefined;
        if (voice) {
          const { voices } = await TextToSpeech.getSupportedVoices();
          const index = voices.findIndex(
            (candidate) => candidate.voiceURI === voice.voiceURI && candidate.name === voice.name,
          );
          if (index >= 0) voiceIndex = index;
        }

        listener = await TextToSpeech.addListener('onRangeStart', () => handlers.onBoundary());
        handlers.onStart();

        // Resolves when the utterance finishes, so this doubles as onEnd.
        await TextToSpeech.speak({
          text,
          lang: voice?.lang || 'en-US',
          rate: settings.rate,
          pitch: settings.pitch,
          volume: settings.volume,
          ...(voiceIndex === undefined ? {} : { voice: voiceIndex }),
        });
      } catch {
        // A failed utterance must still release the speaking state, or the
        // avatar keeps mouthing silently.
      } finally {
        await listener?.remove();
        handlers.onEnd();
      }
    })();
  },

  cancel(): void {
    void TextToSpeech.stop().catch(() => undefined);
  },

  onVoicesChanged(): () => void {
    // The native engine enumerates its voices up front, so the list is stable.
    return () => undefined;
  },
};
