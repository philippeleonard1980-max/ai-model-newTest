import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../renderer/App';
import { setSpeechBackend } from '../renderer/voice/backend';
import { capacitorTtsBackend } from './tts';
import { mobileApi, emitProgress } from './bridge';
import { ensureAssets } from './assets';
import '../renderer/styles.css';
import './mobile.css';

/**
 * Android entry point.
 *
 * Everything platform-specific is installed here, before React mounts: the same
 * `window.kitsune` surface the desktop preload provides, and the native speech
 * backend. From that point on the app is the identical React tree.
 */
window.kitsune = mobileApi;
setSpeechBackend(capacitorTtsBackend);

const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// The avatar and animations are too large to ship inside the APK, so fetch
// whatever is missing once the UI is up rather than blocking the first paint.
void ensureAssets(emitProgress).catch(() => undefined);
