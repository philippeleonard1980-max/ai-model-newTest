import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards the promise that the desktop and Android builds are the same app.
 *
 * The compiler already checks the shape of the platform API, because both
 * implementations are declared `satisfies KitsuneApi`. These tests cover what
 * the type system cannot: that the shared code stays free of platform imports,
 * and that neither shell quietly grows its own copy of the logic.
 */

const read = (path: string): string => readFileSync(path, 'utf8');

describe('the shared core stays platform-neutral', () => {
  const coreFiles = ['gemini.ts', 'memory-doc.ts', 'prompt.ts', 'settings.ts'].map(
    (name) => [`src/core/${name}`, read(`src/core/${name}`)] as const,
  );

  it('imports nothing from Electron, Node or Capacitor', () => {
    for (const [path, source] of coreFiles) {
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
      for (const specifier of imports) {
        expect(
          /^(electron|node:|@capacitor)/.test(specifier),
          `${path} imports "${specifier}", which ties the core to one platform`,
        ).toBe(false);
      }
    }
  });

  it('never reaches for Node globals that a WebView does not have', () => {
    for (const [path, source] of coreFiles) {
      expect(source, `${path} uses Buffer, which does not exist in a WebView`).not.toMatch(
        /\bBuffer\./,
      );
      expect(source).not.toMatch(/\bprocess\.env\b/);
      expect(source).not.toMatch(/\brequire\(/);
    }
  });
});

describe('both shells implement the one contract', () => {
  it('each declares itself against KitsuneApi rather than its own shape', () => {
    expect(read('src/preload/index.ts')).toContain('satisfies KitsuneApi');
    expect(read('src/mobile/bridge.ts')).toContain('satisfies KitsuneApi');
  });

  it('declares the window.kitsune global exactly once', () => {
    const declarations = ['src/shared/api.ts', 'src/preload/index.ts', 'src/mobile/main.tsx']
      .map(read)
      .filter((source) => /interface Window\s*\{/.test(source));
    expect(declarations).toHaveLength(1);
  });

  it('routes the mobile shell through the same core client as the desktop one', () => {
    // If either stopped delegating to core, the two would drift apart silently.
    expect(read('src/mobile/bridge.ts')).toContain("from '../core/gemini'");
    expect(read('src/main/ai/gemini.ts')).toContain("from '../../core/gemini.js'");
  });
});

describe('the renderer is shared, not forked', () => {
  it('contains no platform branching', () => {
    for (const path of [
      'src/renderer/App.tsx',
      'src/renderer/screens/CompanionScreen.tsx',
      'src/renderer/screens/SettingsScreen.tsx',
      'src/renderer/vrm/VrmStage.ts',
    ]) {
      const source = read(path);
      expect(source, `${path} branches on platform`).not.toMatch(
        /Capacitor|isAndroid|isMobile|process\.platform|navigator\.userAgent/,
      );
      expect(source, `${path} imports Electron directly`).not.toMatch(/from\s+'electron'/);
    }
  });

  it('keeps audio behind the speech backend rather than calling the web API directly', () => {
    // Audio has to be produced where the speaker is, so it cannot cross the IPC
    // seam; the backend registry is what keeps the screens platform-agnostic.
    expect(read('src/renderer/voice/speech.ts')).not.toContain('SpeechSynthesisUtterance');
    expect(read('src/renderer/voice/backend.ts')).toContain('SpeechSynthesisUtterance');
  });
});

describe('the Android project is wired up', () => {
  it('registers the local auth plugin, which is not auto-discovered', () => {
    expect(read('android/app/src/main/java/dev/kitsune/companion/MainActivity.java')).toContain(
      'registerPlugin(GoogleAuthPlugin.class)',
    );
  });

  it('declares every permission the app actually uses', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    for (const permission of [
      'android.permission.INTERNET',
      // Capacitor requests both of these when the WebView asks for a mic.
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
    ]) {
      expect(manifest, `manifest is missing ${permission}`).toContain(permission);
    }
  });

  it('can see a text-to-speech engine on Android 11+', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('<queries>');
    expect(manifest).toContain('android.intent.action.TTS_SERVICE');
  });

  it('depends on a Play Services version new enough for the Authorization API', () => {
    const variables = read('android/variables.gradle');
    const match = /playServicesAuthVersion\s*=\s*'(\d+)\.(\d+)\.(\d+)'/.exec(variables);
    expect(match, 'playServicesAuthVersion is not pinned').not.toBeNull();
    const [major, minor] = [Number(match![1]), Number(match![2])];
    // AuthorizationRequest/AuthorizationResult arrived in 20.7.0.
    expect(major > 20 || (major === 20 && minor >= 7)).toBe(true);
    expect(read('android/app/build.gradle')).toContain('play-services-auth');
  });

  it('points Capacitor at the mobile bundle', () => {
    expect(read('capacitor.config.ts')).toContain("webDir: 'dist-mobile'");
    expect(read('capacitor.config.ts')).toContain("appId: 'dev.kitsune.companion'");
  });
});
