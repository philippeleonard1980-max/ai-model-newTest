import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, AssetStatus, AuthState, ChatMessage, Emotion } from '@shared/types';
import { CompanionScreen } from './screens/CompanionScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { Speaker } from './voice/speech';
import { speechBackend } from './voice/backend';

export type ScreenName = 'companion' | 'settings';

export function App(): JSX.Element {
  const [screen, setScreen] = useState<ScreenName>('companion');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [assets, setAssets] = useState<AssetStatus | null>(null);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [emotion, setEmotion] = useState<Emotion>('neutral');
  const [speaking, setSpeaking] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const energyRef = useRef<(level: number) => void>(() => undefined);

  const speaker = useMemo(
    () =>
      new Speaker(
        (level) => energyRef.current(level),
        (isSpeaking) => setSpeaking(isSpeaking),
      ),
    [],
  );

  const refreshAuth = useCallback(async () => {
    try {
      setAuth(await window.kitsune.auth.state());
    } catch (error) {
      setBanner((error as Error).message);
    }
  }, []);

  const refreshAssets = useCallback(async () => {
    try {
      setAssets(await window.kitsune.assets.status());
    } catch (error) {
      setBanner((error as Error).message);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [loadedSettings, loadedAuth, loadedAssets, loadedVoices] = await Promise.all([
          window.kitsune.settings.get(),
          window.kitsune.auth.state(),
          window.kitsune.assets.status(),
          Speaker.ready(),
        ]);
        setSettings(loadedSettings);
        setAuth(loadedAuth);
        setAssets(loadedAssets);
        setVoices(loadedVoices);
        if (!loadedAuth.clientConfigured) {
          setBanner(
            'Rin needs a Google sign-in before she can talk. Open Settings to connect your account — it takes about two minutes.',
          );
        } else if (!loadedAuth.signedIn) {
          setBanner('You are not signed in to Google. Open Settings and sign in.');
        }
      } catch (error) {
        setBanner((error as Error).message);
      }
    })();
  }, []);

  // Windows enumerates SAPI voices asynchronously, and on a slow start the
  // initial wait can time out before any arrive. Keep listening for the rest of
  // the session rather than leaving the picker empty until the app restarts.
  useEffect(() => speechBackend().onVoicesChanged(setVoices), []);

  // Stop the voice when the window goes away, so she is not left talking to
  // an empty desktop.
  useEffect(() => {
    const stop = (): void => speaker.cancel();
    window.addEventListener('beforeunload', stop);
    return () => {
      window.removeEventListener('beforeunload', stop);
      stop();
    };
  }, [speaker]);

  const updateSettings = useCallback(async (next: AppSettings) => {
    const saved = await window.kitsune.settings.set(next);
    setSettings(saved);
    return saved;
  }, []);

  if (!settings) {
    return (
      <div className="boot">
        <div className="boot-fox">🦊</div>
        <p>Waking Rin up…</p>
      </div>
    );
  }

  return (
    <div className="app">
      <nav className="tabs">
        <div className="brand">
          <span className="brand-mark">🦊</span>
          <span className="brand-name">Kitsune Companion</span>
        </div>
        <button
          type="button"
          className={screen === 'companion' ? 'tab active' : 'tab'}
          onClick={() => setScreen('companion')}
        >
          Companion
        </button>
        <button
          type="button"
          className={screen === 'settings' ? 'tab active' : 'tab'}
          onClick={() => setScreen('settings')}
        >
          Personality &amp; Memory
        </button>
        <div className="tab-spacer" />
        <span className={auth?.signedIn ? 'status ok' : 'status warn'}>
          {auth?.signedIn ? (auth.email ?? 'Signed in') : 'Not signed in'}
        </span>
      </nav>

      {banner && (
        <div className="banner">
          <span>{banner}</span>
          <button type="button" onClick={() => setBanner(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <main className="screen">
        {/* Both screens stay mounted: unmounting the companion would tear down
            the WebGL context and reload the avatar on every tab switch. */}
        <div hidden={screen !== 'companion'} className="screen-pane">
          <CompanionScreen
            settings={settings}
            assets={assets}
            voices={voices}
            speaker={speaker}
            messages={messages}
            setMessages={setMessages}
            emotion={emotion}
            setEmotion={setEmotion}
            speaking={speaking}
            registerEnergySink={(sink) => {
              energyRef.current = sink;
            }}
            onError={setBanner}
            onNeedsSetup={() => setScreen('settings')}
          />
        </div>
        <div hidden={screen !== 'settings'} className="screen-pane">
          <SettingsScreen
            active={screen === 'settings'}
            settings={settings}
            auth={auth}
            assets={assets}
            voices={voices}
            speaker={speaker}
            onSettings={updateSettings}
            onAuthChanged={refreshAuth}
            onAssetsChanged={refreshAssets}
            onError={setBanner}
          />
        </div>
      </main>
    </div>
  );
}
