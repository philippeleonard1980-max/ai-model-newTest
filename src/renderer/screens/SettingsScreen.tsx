import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { ModelOption } from '@shared/api';
import type {
  AppSettings,
  AssetStatus,
  AuthState,
  CatalogEntry,
  DownloadProgress,
  GeminiBackend,
  SetupCapability,
  SetupStep,
} from '@shared/types';
import type { Speaker } from '../voice/speech';
import { MarkdownBlock } from '../components/MarkdownBlock';

interface Props {
  /** True while the settings screen is the visible one. */
  active: boolean;
  settings: AppSettings;
  auth: AuthState | null;
  assets: AssetStatus | null;
  voices: SpeechSynthesisVoice[];
  speaker: Speaker;
  onSettings: (settings: AppSettings) => Promise<AppSettings>;
  onAuthChanged: () => Promise<void>;
  onAssetsChanged: () => Promise<void>;
  onError: (message: string) => void;
}

type Tab = 'personality' | 'memory' | 'connection' | 'avatar' | 'voice';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'personality', label: 'Personality' },
  { id: 'memory', label: 'Memory' },
  { id: 'connection', label: 'Google & Gemini' },
  { id: 'avatar', label: 'Avatar' },
  { id: 'voice', label: 'Voice' },
];

export function SettingsScreen(props: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('personality');

  return (
    <div className="settings">
      <nav className="subtabs">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={tab === entry.id ? 'subtab active' : 'subtab'}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="settings-body">
        {tab === 'personality' && <PersonalityPanel onError={props.onError} />}
        {tab === 'memory' && <MemoryPanel visible={props.active} onError={props.onError} />}
        {tab === 'connection' && <ConnectionPanel {...props} />}
        {tab === 'avatar' && <AvatarPanel {...props} />}
        {tab === 'voice' && <VoicePanel {...props} />}
      </div>
    </div>
  );
}

/* --------------------------- personality box --------------------------- */

function PersonalityPanel({ onError }: { onError: (message: string) => void }): JSX.Element {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [path, setPath] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const persona = await window.kitsune.persona.get();
      setText(persona.text);
      setSaved(persona.text);
      setPath(persona.path);
    } catch (error) {
      onError((error as Error).message);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = text !== saved;

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Rin's personality</h2>
          <p>
            This is the system prompt behind every reply. Rewrite any of it — tone, quirks, rules,
            even her name — and the change applies to the next message you send.
          </p>
        </div>
        <div className="panel-actions">
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              if (!confirm('Restore the original fox-girl personality? Your edits will be lost.')) return;
              try {
                const persona = await window.kitsune.persona.reset();
                setText(persona.text);
                setSaved(persona.text);
                setStatus('Restored the default personality.');
              } catch (error) {
                onError((error as Error).message);
              }
            }}
          >
            Restore default
          </button>
          <button
            type="button"
            className="primary"
            disabled={!dirty}
            onClick={async () => {
              try {
                const persona = await window.kitsune.persona.set(text);
                setSaved(persona.text);
                setStatus('Saved.');
              } catch (error) {
                onError((error as Error).message);
              }
            }}
          >
            {dirty ? 'Save personality' : 'Saved'}
          </button>
        </div>
      </header>

      <textarea
        className="editor"
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          setStatus(null);
        }}
      />
      <footer className="panel-foot">
        <code title={path}>{path}</code>
        {status && <span className="ok">{status}</span>}
        {dirty && <span className="warn">Unsaved changes</span>}
      </footer>
    </section>
  );
}

/* ------------------------------- memory -------------------------------- */

function MemoryPanel({
  visible,
  onError,
}: {
  visible: boolean;
  onError: (message: string) => void;
}): JSX.Element {
  const [markdown, setMarkdown] = useState('');
  const [saved, setSaved] = useState('');
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const memory = await window.kitsune.memory.get();
      setMarkdown(memory.markdown);
      setSaved(memory.markdown);
      setPath(memory.path);
    } catch (error) {
      onError((error as Error).message);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = markdown !== saved;

  // Rin rewrites this file behind the scenes while you are on the other screen,
  // and this panel stays mounted across screen switches, so the copy loaded on
  // mount goes stale. Re-read whenever the panel comes back into view. A window
  // `focus` listener is not enough: switching screens inside the app never
  // fires one. Unsaved edits win, so re-reading cannot discard your typing.
  useEffect(() => {
    if (visible && !dirty) void load();
    // `dirty` is deliberately not a dependency: this should fire when the panel
    // becomes visible, not every time the textarea changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, load]);

  return (
    <section className="panel">
      <header className="panel-head">
        <div>
          <h2>Rin's memory</h2>
          <p>
            A plain Markdown file Rin reads before every reply and writes to with her{' '}
            <code>remember</code>, <code>update_memory</code> and <code>forget</code> tools. Edit it
            here and she will believe whatever it says — delete a line to make her forget it.
          </p>
        </div>
        <div className="panel-actions">
          <button type="button" className="ghost" onClick={() => void load()} disabled={dirty}>
            Reload
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setMode(mode === 'preview' ? 'edit' : 'preview')}
          >
            {mode === 'preview' ? 'Edit' : 'Preview'}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!dirty}
            onClick={async () => {
              try {
                // Rin may have written to the file since this buffer was loaded.
                // Overwriting that silently would destroy a memory she just made.
                const current = await window.kitsune.memory.get();
                if (current.markdown !== saved) {
                  const overwrite = confirm(
                    'Rin has changed her memory since you started editing.\n\n' +
                      'Saving now replaces her version with yours. Cancel to keep hers ' +
                      'and press Reload to see it.',
                  );
                  if (!overwrite) return;
                }
                const memory = await window.kitsune.memory.set(markdown);
                setSaved(memory.markdown);
                setStatus('Saved.');
              } catch (error) {
                onError((error as Error).message);
              }
            }}
          >
            {dirty ? 'Save memory' : 'Saved'}
          </button>
        </div>
      </header>

      {mode === 'edit' ? (
        <textarea
          className="editor"
          value={markdown}
          spellCheck={false}
          onChange={(event) => {
            setMarkdown(event.target.value);
            setStatus(null);
          }}
        />
      ) : (
        <div className="memory-preview">
          <MarkdownBlock markdown={markdown || '_Empty._'} />
        </div>
      )}

      <footer className="panel-foot">
        <button type="button" className="linkish" onClick={() => void window.kitsune.shell.openPath(path)}>
          Open file
        </button>
        <code title={path}>{path}</code>
        {status && <span className="ok">{status}</span>}
        {dirty && <span className="warn">Unsaved changes</span>}
      </footer>
    </section>
  );
}

/* ---------------------------- google + gemini --------------------------- */

const SETUP_URL = 'https://console.cloud.google.com/apis/credentials';
const CONSENT_URL = 'https://console.cloud.google.com/apis/credentials/consent';
const ENABLE_API_URL =
  'https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com';

function ConnectionPanel({ settings, auth, onSettings, onAuthChanged, onError }: Props): JSX.Element {
  const [capability, setCapability] = useState<SetupCapability | null>(null);
  const [steps, setSteps] = useState<SetupStep[]>([]);
  const [running, setRunning] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [client, caps] = await Promise.all([
          window.kitsune.auth.getClient(),
          window.kitsune.auth.capability(),
        ]);
        if (client) {
          setClientId(client.clientId);
          setClientSecret(client.clientSecret ?? '');
        }
        setCapability(caps);
      } catch (error) {
        onError((error as Error).message);
      }
    })();
    // Progress arrives step by step; replace an existing step of the same id so
    // "running" turns into "done" in place rather than stacking up.
    return window.kitsune.auth.onSetupStep((step) =>
      setSteps((previous) => {
        const next = previous.filter((entry) => entry.id !== step.id);
        return [...next, step];
      }),
    );
  }, [onError]);

  const patch = async (change: Partial<AppSettings['gemini']>): Promise<void> => {
    try {
      await onSettings({ ...settings, gemini: { ...settings.gemini, ...change } });
    } catch (error) {
      onError((error as Error).message);
    }
  };

  const setUp = async (): Promise<void> => {
    setRunning(true);
    setSteps([]);
    try {
      await window.kitsune.auth.autoSetup();
      await onAuthChanged();
    } catch (error) {
      // The failing step already explains itself in the checklist, so the
      // banner would only repeat it.
      if (steps.every((step) => step.state !== 'failed')) onError((error as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const ready = auth?.signedIn === true;

  return (
    <section className="panel scroll">
      <h2>Google account</h2>
      <p className="lead">
        Rin talks to Gemini through your own Google account. No API key, and nothing to copy or
        paste — press the button and the app does the rest.
      </p>

      <div className={ready ? 'setup-card ready' : 'setup-card'}>
        <div className="setup-head">
          <div>
            <h3>{ready ? 'Connected' : 'Set up Gemini'}</h3>
            <p className="muted small">
              {ready
                ? auth?.method === 'adc'
                  ? `Signed in with your Google account${auth?.email ? ` (${auth.email})` : ''}.`
                  : 'Signed in with your own OAuth client.'
                : 'Signs you in, finds your Google Cloud project and switches the Gemini API on.'}
            </p>
          </div>
          <button type="button" className="primary" disabled={running} onClick={() => void setUp()}>
            {running ? 'Setting up…' : ready ? 'Run setup again' : 'Set up automatically'}
          </button>
        </div>

        {steps.length > 0 && (
          <ol className="setup-steps">
            {steps.map((step) => (
              <li key={step.id} className={`setup-step ${step.state}`}>
                <span className="setup-mark" aria-hidden="true">
                  {step.state === 'done' ? '✓' : step.state === 'failed' ? '!' : '·'}
                </span>
                <div>
                  <span className="setup-label">{step.label}</span>
                  {step.detail && <p className="setup-detail">{step.detail}</p>}
                  {step.helpUrl && (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => void window.kitsune.shell.openExternal(step.helpUrl!)}
                    >
                      Open the page that fixes this
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}

        {capability && !capability.hasAdc && !capability.hasGcloud && !running && (
          <div className="callout">
            Automatic setup drives the <strong>Google Cloud CLI</strong>, which is the one thing you
            have to install yourself. It is a normal installer and takes a couple of minutes.{' '}
            <button
              type="button"
              className="linkish"
              onClick={() => void window.kitsune.shell.openExternal(capability.gcloudInstallUrl)}
            >
              Download it
            </button>
            , then come back and press the button.
          </div>
        )}

        {ready && (
          <div className="row">
            <button
              type="button"
              className="ghost"
              onClick={async () => {
                try {
                  await window.kitsune.auth.signOut();
                  await onAuthChanged();
                } catch (error) {
                  onError((error as Error).message);
                }
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>

      <button type="button" className="linkish disclosure" onClick={() => setShowManual(!showManual)}>
        {showManual ? 'Hide' : 'Set it up by hand instead'}
      </button>

      {showManual && (
        <div className="manual-setup">
          <p className="muted small">
            Only needed if you would rather not install the Cloud CLI. Create an OAuth client of
            type <strong>Desktop app</strong>, and note that a brand-new project also needs its
            consent screen configured first — that step is what usually trips people up.
          </p>
          <div className="row">
            <button
              type="button"
              className="ghost"
              onClick={() => void window.kitsune.shell.openExternal(CONSENT_URL)}
            >
              1. Consent screen
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => void window.kitsune.shell.openExternal(SETUP_URL)}
            >
              2. Create the client
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => void window.kitsune.shell.openExternal(ENABLE_API_URL)}
            >
              3. Enable the API
            </button>
          </div>
          <div className="field">
            <label htmlFor="client-id">OAuth client ID</label>
            <input
              id="client-id"
              value={clientId}
              spellCheck={false}
              placeholder="1234567890-abcdefg.apps.googleusercontent.com"
              onChange={(event) => setClientId(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="client-secret">Client secret (optional — this app uses PKCE)</label>
            <input
              id="client-secret"
              value={clientSecret}
              type="password"
              spellCheck={false}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </div>
          <div className="row">
            <button
              type="button"
              className="ghost"
              disabled={busy === 'signin'}
              onClick={async () => {
                setBusy('signin');
                try {
                  await window.kitsune.auth.setClient({
                    clientId,
                    clientSecret: clientSecret || undefined,
                  });
                  await window.kitsune.auth.signIn();
                  await onAuthChanged();
                } catch (error) {
                  onError((error as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'signin' ? 'Waiting for your browser…' : 'Sign in with this client'}
            </button>
          </div>
        </div>
      )}

      <hr />

      <h2>Model</h2>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="backend">Backend</label>
          <select
            id="backend"
            value={settings.gemini.backend}
            onChange={(event) => void patch({ backend: event.target.value as GeminiBackend })}
          >
            <option value="generativelanguage">Gemini API (recommended)</option>
            <option value="vertex">Vertex AI (needs a billed Cloud project)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="model">Model</label>
          <div className="row tight">
            <input
              id="model"
              value={settings.gemini.model}
              spellCheck={false}
              list="model-options"
              onChange={(event) => void patch({ model: event.target.value })}
            />
            <datalist id="model-options">
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </datalist>
            <button
              type="button"
              className="ghost"
              disabled={busy === 'models'}
              onClick={async () => {
                setBusy('models');
                try {
                  setModels(await window.kitsune.chat.models());
                } catch (error) {
                  onError((error as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'models' ? 'Loading…' : 'Refresh list'}
            </button>
          </div>
        </div>
        <div className="field">
          <label htmlFor="project">
            Cloud project {settings.gemini.backend === 'vertex' ? '(required)' : '(filled in by setup)'}
          </label>
          <input
            id="project"
            value={settings.gemini.projectId ?? ''}
            spellCheck={false}
            placeholder={settings.gemini.backend === 'vertex' ? 'my-project-id' : 'set automatically'}
            onChange={(event) => void patch({ projectId: event.target.value })}
          />
        </div>
        {settings.gemini.backend === 'vertex' && (
          <div className="field">
            <label htmlFor="location">Location</label>
            <input
              id="location"
              value={settings.gemini.location ?? 'global'}
              spellCheck={false}
              onChange={(event) => void patch({ location: event.target.value })}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="temperature">Temperature — {settings.gemini.temperature.toFixed(2)}</label>
          <input
            id="temperature"
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={settings.gemini.temperature}
            onChange={(event) => void patch({ temperature: Number(event.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="max-tokens">Max output tokens</label>
          <input
            id="max-tokens"
            type="number"
            min={256}
            max={32768}
            step={256}
            value={settings.gemini.maxOutputTokens}
            onChange={(event) => void patch({ maxOutputTokens: Number(event.target.value) })}
          />
        </div>
      </div>
    </section>
  );
}

/* -------------------------------- avatar -------------------------------- */

function AvatarPanel({ settings, assets, onSettings, onAssetsChanged, onError }: Props): JSX.Element {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setCatalog(await window.kitsune.assets.catalog());
      } catch (error) {
        onError((error as Error).message);
      }
    })();
    return window.kitsune.assets.onProgress(setProgress);
  }, [onError]);

  const patch = async (change: Partial<AppSettings['avatar']>): Promise<void> => {
    try {
      await onSettings({ ...settings, avatar: { ...settings.avatar, ...change } });
    } catch (error) {
      onError((error as Error).message);
    }
  };

  return (
    <section className="panel scroll">
      <h2>Avatar</h2>
      <p className="lead">
        Rin is an existing public-domain VRM model, downloaded rather than generated. Pick one
        below, or point her at any <code>.vrm</code> file on your computer.
      </p>

      {assets?.usingFallback && (
        <div className="callout">
          The fox avatar is not installed — Rin is using the stand-in model. Install{' '}
          <strong>Megan the Fox</strong> below to give her ears and a tail.
        </div>
      )}

      <div className="model-list">
        {catalog.map((entry) => {
          const active = assets?.modelName === entry.name;
          const downloading = busy === entry.id;
          const percent =
            progress && progress.id === entry.id && progress.totalBytes
              ? Math.round((progress.receivedBytes / progress.totalBytes) * 100)
              : null;
          return (
            <article key={entry.id} className={active ? 'model-card active' : 'model-card'}>
              <header>
                <h3>{entry.name}</h3>
                {entry.fox && <span className="pill">fox</span>}
                {active && <span className="pill">in use</span>}
                {!entry.licenseVerified && (
                  <span className="pill caution" title="Licence not machine-readable — check the source page">
                    licence unverified
                  </span>
                )}
              </header>
              <p>{entry.description}</p>
              <footer>
                <span className="license">
                  {entry.license} — {entry.credit}
                  {!entry.licenseVerified && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => void window.kitsune.shell.openExternal(entry.sourceUrl)}
                      >
                        check the terms
                      </button>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="ghost"
                  disabled={downloading}
                  onClick={async () => {
                    setBusy(entry.id);
                    try {
                      await window.kitsune.assets.install(entry.id);
                      await onAssetsChanged();
                    } catch (error) {
                      onError((error as Error).message);
                    } finally {
                      setBusy(null);
                      setProgress(null);
                    }
                  }}
                >
                  {downloading
                    ? percent !== null
                      ? `Downloading ${percent}%`
                      : 'Downloading…'
                    : active
                      ? 'Reinstall'
                      : 'Install & use'}
                </button>
              </footer>
            </article>
          );
        })}
      </div>

      <p className="muted small">
        Want a different fox? VRoid Hub and Booth are full of VTuber-style kitsune avatars.
        Download any <code>.vrm</code> in your browser and load it below — every animation
        retargets onto it automatically.
      </p>

      <div className="row">
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            try {
              const next = await window.kitsune.assets.pickLocal();
              if (next) await onAssetsChanged();
            } catch (error) {
              onError((error as Error).message);
            }
          }}
        >
          Use a .vrm file from my computer…
        </button>
        <code className="muted" title={assets?.modelPath ?? ''}>
          {assets?.modelPath ?? 'no avatar installed'}
        </code>
      </div>

      <hr />

      <h2>Framing</h2>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="cam-height">Camera height — {settings.avatar.cameraHeight.toFixed(2)}</label>
          <input
            id="cam-height"
            type="range"
            min={0.4}
            max={1.8}
            step={0.01}
            value={settings.avatar.cameraHeight}
            onChange={(event) => void patch({ cameraHeight: Number(event.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="cam-distance">Distance — {settings.avatar.cameraDistance.toFixed(2)}</label>
          <input
            id="cam-distance"
            type="range"
            min={0.6}
            max={4}
            step={0.05}
            value={settings.avatar.cameraDistance}
            onChange={(event) => void patch({ cameraDistance: Number(event.target.value) })}
          />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.avatar.lookAtCursor}
            onChange={(event) => void patch({ lookAtCursor: event.target.checked })}
          />
          Follow the mouse cursor with her eyes and head
        </label>
      </div>

      <p className="muted small">
        {assets?.animations.length ?? 0} animation clips installed:{' '}
        {assets?.animations.map((clip) => clip.name).join(', ') || 'none'}.
      </p>
    </section>
  );
}

/* --------------------------------- voice -------------------------------- */

function VoicePanel({ settings, voices, speaker, onSettings, onError }: Props): JSX.Element {
  const patch = async (change: Partial<AppSettings['voice']>): Promise<void> => {
    try {
      await onSettings({ ...settings, voice: { ...settings.voice, ...change } });
    } catch (error) {
      onError((error as Error).message);
    }
  };

  return (
    <section className="panel scroll">
      <h2>Voice</h2>
      <p className="lead">
        Replies are spoken with a Windows system voice, so there is no extra service and no delay
        waiting on audio to download. Add more voices under Windows Settings → Time &amp; language →
        Speech.
      </p>

      <label className="check">
        <input
          type="checkbox"
          checked={settings.voice.speak}
          onChange={(event) => void patch({ speak: event.target.checked })}
        />
        Speak replies out loud
      </label>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="voice">Voice</label>
          <select
            id="voice"
            value={settings.voice.voiceURI ?? ''}
            onChange={(event) => void patch({ voiceURI: event.target.value || null })}
          >
            <option value="">Choose automatically</option>
            {voices.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {voice.name} ({voice.lang})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rate">Rate — {settings.voice.rate.toFixed(2)}</label>
          <input
            id="rate"
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={settings.voice.rate}
            onChange={(event) => void patch({ rate: Number(event.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="pitch">Pitch — {settings.voice.pitch.toFixed(2)}</label>
          <input
            id="pitch"
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={settings.voice.pitch}
            onChange={(event) => void patch({ pitch: Number(event.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="volume">Volume — {settings.voice.volume.toFixed(2)}</label>
          <input
            id="volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.voice.volume}
            onChange={(event) => void patch({ volume: Number(event.target.value) })}
          />
        </div>
      </div>

      <div className="row">
        <button
          type="button"
          className="ghost"
          onClick={() =>
            speaker.speak(
              "Seven tails, and every one of them says you should have gone to bed an hour ago.",
              settings.voice,
              voices,
            )
          }
        >
          Test voice
        </button>
        <button type="button" className="ghost" onClick={() => speaker.cancel()}>
          Stop
        </button>
        {voices.length === 0 && (
          <span className="status warn">No speech voices found on this system.</span>
        )}
      </div>
    </section>
  );
}
