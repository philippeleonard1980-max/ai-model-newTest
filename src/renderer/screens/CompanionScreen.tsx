import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { assetUrl } from '@shared/ipc';
import type { AppSettings, AssetStatus, ChatMessage, Emotion } from '@shared/types';
import { VrmStage } from '../vrm/VrmStage';
import { PushToTalkRecorder } from '../voice/recorder';
import type { Speaker } from '../voice/speech';
import { MarkdownBlock } from '../components/MarkdownBlock';

interface Props {
  settings: AppSettings;
  assets: AssetStatus | null;
  voices: SpeechSynthesisVoice[];
  speaker: Speaker;
  messages: ChatMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  emotion: Emotion;
  setEmotion: (emotion: Emotion) => void;
  speaking: boolean;
  registerEnergySink: (sink: (level: number) => void) => void;
  onError: (message: string) => void;
  onNeedsSetup: () => void;
}

type TalkState = 'idle' | 'recording' | 'transcribing' | 'thinking';

function newId(): string {
  return crypto.randomUUID();
}

export function CompanionScreen({
  settings,
  assets,
  voices,
  speaker,
  messages,
  setMessages,
  emotion,
  setEmotion,
  speaking,
  registerEnergySink,
  onError,
  onNeedsSetup,
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<VrmStage | null>(null);
  const recorderRef = useRef<PushToTalkRecorder | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const [draft, setDraft] = useState('');
  const [talkState, setTalkState] = useState<TalkState>('idle');
  const [micLevel, setMicLevel] = useState(0);
  const [stageError, setStageError] = useState<string | null>(null);
  const [loadingModel, setLoadingModel] = useState(true);

  /* ------------------------------ 3D stage ------------------------------ */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stage = new VrmStage(canvas, {
      framing: settings.avatar.framing,
      lookAtCursor: settings.avatar.lookAtCursor,
    });
    stageRef.current = stage;
    stage.start();
    registerEnergySink((level) => stage.setSpeechEnergy(level));
    return () => {
      stage.dispose();
      stageRef.current = null;
    };
    // Built once: later setting changes are applied through setOptions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    stageRef.current?.setOptions({
      framing: settings.avatar.framing,
      lookAtCursor: settings.avatar.lookAtCursor,
    });
  }, [settings.avatar.framing, settings.avatar.lookAtCursor]);

  // Load (or reload) the avatar and its animation clips whenever the installed
  // assets change — for example right after the fox model finishes downloading.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !assets) return;
    let cancelled = false;

    void (async () => {
      setLoadingModel(true);
      setStageError(null);
      try {
        if (!assets.modelPath) {
          throw new Error(
            'No avatar is installed yet. Open Personality & Memory → Avatar to download one.',
          );
        }
        await stage.loadModel(assetUrl(assets.modelPath));
        if (cancelled) return;
        const clips = new Map(assets.animations.map((clip) => [clip.name, assetUrl(clip.path)]));
        await stage.loadAnimations(clips);
      } catch (error) {
        if (!cancelled) setStageError((error as Error).message);
      } finally {
        if (!cancelled) setLoadingModel(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assets]);

  useEffect(() => {
    stageRef.current?.setEmotion(emotion);
  }, [emotion]);

  useEffect(() => {
    stageRef.current?.setSpeaking(speaking);
  }, [speaking]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    const y = -(((event.clientY - bounds.top) / bounds.height) * 2 - 1);
    stageRef.current?.setPointer(x, y);
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, talkState]);

  /* -------------------------------- chat -------------------------------- */

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || talkState === 'thinking') return;

      speaker.cancel();
      const userMessage: ChatMessage = { id: newId(), role: 'user', text: trimmed, at: Date.now() };
      // Snapshot the history before appending, so the model does not receive
      // the current turn twice.
      const history = messages;
      setMessages((previous) => [...previous, userMessage]);
      setDraft('');
      setTalkState('thinking');
      setEmotion('thinking');

      try {
        const reply = await window.kitsune.chat.send(trimmed, history);
        setMessages((previous) => [
          ...previous,
          {
            id: newId(),
            role: 'assistant',
            text: reply.text,
            at: Date.now(),
            emotion: reply.emotion,
            memoryOps: reply.memoryOps,
          },
        ]);
        setEmotion(reply.emotion);
        if (settings.voice.speak) {
          speaker.speak(reply.speech, settings.voice, voices);
        }
      } catch (error) {
        const message = (error as Error).message;
        onError(message);
        setEmotion('sad');
        if (/sign in|client ID|OAuth/i.test(message)) onNeedsSetup();
      } finally {
        setTalkState('idle');
      }
    },
    [messages, onError, onNeedsSetup, setEmotion, setMessages, settings.voice, speaker, talkState, voices],
  );

  /* ---------------------------- push to talk ---------------------------- */

  const startRecording = useCallback(async () => {
    if (talkState !== 'idle') return;
    speaker.cancel();
    const recorder = new PushToTalkRecorder(setMicLevel);
    recorderRef.current = recorder;
    try {
      await recorder.start();
      setTalkState('recording');
    } catch (error) {
      recorderRef.current = null;
      onError(
        `Could not open the microphone: ${(error as Error).message}. Check Windows privacy settings for microphone access.`,
      );
    }
  }, [onError, speaker, talkState]);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorderRef.current = null;
    setTalkState('transcribing');
    try {
      const recording = await recorder.stop();
      if (!recording) {
        setTalkState('idle');
        return;
      }
      const transcript = await window.kitsune.chat.transcribe(recording.audio, recording.mimeType);
      if (!transcript.trim()) {
        setTalkState('idle');
        onError('Rin did not catch any speech in that clip. Try holding the button a little longer.');
        return;
      }
      setTalkState('idle');
      await send(transcript);
    } catch (error) {
      setTalkState('idle');
      onError((error as Error).message);
    }
  }, [onError, send]);

  // Space bar acts as push-to-talk whenever focus is not in a text field.
  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    const down = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || isTyping(event.target)) return;
      event.preventDefault();
      void startRecording();
    };
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isTyping(event.target)) return;
      event.preventDefault();
      void stopRecording();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [startRecording, stopRecording]);

  const busy = talkState === 'thinking' || talkState === 'transcribing';

  return (
    <div className="companion">
      <div className="stage" onPointerMove={handlePointerMove}>
        <canvas ref={canvasRef} className="stage-canvas" />
        <div className="stage-overlay">
          {loadingModel && !stageError && <div className="stage-note">Summoning Rin…</div>}
          {stageError && <div className="stage-note error">{stageError}</div>}
        </div>
        <div className="stage-controls">
          <button
            type="button"
            className="stage-button"
            title="Back to the default view"
            onClick={() => stageRef.current?.resetView()}
          >
            Reset view
          </button>
          <span className="stage-hint">drag to turn · scroll to zoom · right-drag to slide</span>
        </div>

        <div className="stage-badges">
          <span className={`mood mood-${emotion}`}>{emotion}</span>
          {assets?.usingFallback && (
            <span className="mood warn" title="The fox avatar is not installed yet">
              stand-in avatar
            </span>
          )}
          {speaking && <span className="mood speaking">speaking</span>}
        </div>
      </div>

      <aside className="conversation">
        <div className="transcript" ref={transcriptRef}>
          {messages.length === 0 && (
            <div className="empty">
              <h2>Seven tails, at your service.</h2>
              <p>
                Type below, or hold <kbd>Space</kbd> (or the <em>Hold to talk</em> button) and speak.
                Rin answers out loud and in text, and remembers what matters.
              </p>
            </div>
          )}

          {messages.map((message) => (
            <article key={message.id} className={`bubble ${message.role}`}>
              <header>
                <span className="who">{message.role === 'user' ? 'You' : 'Rin'}</span>
                {message.memoryOps && message.memoryOps.length > 0 && (
                  <span className="memory-chip" title={message.memoryOps.map((op) => op.detail).join('\n')}>
                    memory updated
                  </span>
                )}
              </header>
              {message.role === 'assistant' ? (
                <MarkdownBlock markdown={message.text} />
              ) : (
                <p className="plain">{message.text}</p>
              )}
            </article>
          ))}

          {talkState === 'transcribing' && <div className="pending">Listening back…</div>}
          {talkState === 'thinking' && <div className="pending">Rin is thinking…</div>}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            value={draft}
            placeholder="Ask Rin something…"
            rows={2}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          <div className="composer-actions">
            <button
              type="button"
              className={talkState === 'recording' ? 'talk recording' : 'talk'}
              disabled={busy}
              onPointerDown={() => void startRecording()}
              onPointerUp={() => void stopRecording()}
              onPointerLeave={() => {
                if (talkState === 'recording') void stopRecording();
              }}
            >
              <span
                className="talk-level"
                style={{ transform: `scaleX(${talkState === 'recording' ? micLevel : 0})` }}
              />
              <span className="talk-label">
                {talkState === 'recording' ? 'Release to send' : 'Hold to talk'}
              </span>
            </button>
            {speaking ? (
              <button type="button" className="ghost" onClick={() => speaker.cancel()}>
                Stop voice
              </button>
            ) : null}
            <button type="submit" className="primary" disabled={busy || draft.trim().length === 0}>
              Send
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
