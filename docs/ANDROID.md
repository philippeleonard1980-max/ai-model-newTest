# The Android build

Same app, same character, same memory file — running in a Capacitor shell
instead of Electron.

## What is actually shared

The React app, the 3D stage, the animation director, the persona and the memory
format are **the same source files** on both platforms. Only the thin layer
underneath differs:

| | Desktop | Android |
|---|---|---|
| Shell | Electron | Capacitor |
| Platform API | preload over IPC | `src/mobile/bridge.ts` |
| Sign-in | PKCE loopback in a browser | Play Services Authorization API |
| Persona / memory | files in `%APPDATA%` | files in app storage |
| Settings | `settings.json` | Capacitor Preferences |
| Speech | Windows SAPI via Web Speech | native `TextToSpeech` |
| Avatar files | private `kitsune-asset://` protocol | `convertFileSrc` |
| Speech-to-text | recorded clip → Gemini | identical |

Both shells are declared `satisfies KitsuneApi`, a contract defined once in
`src/shared/api.ts`. If one drifts from the other, the build fails rather than
the app. `test/parity.test.ts` additionally checks that `src/core` imports
nothing from Electron, Node or Capacitor, and that no screen branches on
platform.

## Sign-in is different on Android, and it has to be

The desktop app opens a browser, catches a redirect on `127.0.0.1` and does a
PKCE exchange. That is not available on Android:

- Google **restricted custom URI schemes** for new Android OAuth clients, so the
  usual `com.googleusercontent.apps.…:/callback` redirect is closed.
- The **device-code flow** would avoid redirects entirely, but its scope
  allowlist excludes `cloud-platform`, which is exactly what Gemini needs.

What remains — and what Google points at — is the **Play Services Authorization
API**. It returns an OAuth access token straight to the app: no redirect, no
client secret, no server. Still your Google account, still no API key.

Tokens last about an hour and there is no refresh token. That is deliberate:
once you have granted the scope, re-authorizing is silent, so the app just asks
again when the cached token is close to expiring. You only ever see a consent
screen when Google genuinely requires one.

## Setup

### 1. Register an Android OAuth client

Android identifies the app by its **package name and signing certificate**
rather than a client ID you paste in, so there is nothing to type into the app —
but Google has to know about your build.

Get your debug signing fingerprint:

```sh
keytool -list -v -alias androiddebugkey \
  -keystore ~/.android/debug.keystore \
  -storepass android -keypass android | grep SHA1
```

On Windows the keystore is at `%USERPROFILE%\.android\debug.keystore`.

Then in <https://console.cloud.google.com/apis/credentials>, in the same project
you used for the desktop app:

1. **Create credentials → OAuth client ID → Android**
2. Package name: `dev.kitsune.companion`
3. SHA-1: the fingerprint from above
4. Make sure the **Generative Language API** is enabled on the project

Release builds are signed with a different key, so add a second Android client
with the release fingerprint when you ship one.

> If sign-in fails with *"This build is not registered with Google"*, that is
> `DEVELOPER_ERROR` — the package name or the fingerprint does not match.

### 2. Build

```sh
npm install
npm run build:mobile      # Vite build into dist-mobile/
npm run sync:android      # build + copy into the Android project
npm run open:android      # open in Android Studio
```

Then Run from Android Studio, or:

```sh
cd android && ./gradlew assembleDebug
# android/app/build/outputs/apk/debug/app-debug.apk
```

Android Studio supplies the SDK; `npm run sync:android` does not need it.

### 3. First run

The avatar and animation clips are **not** in the APK — the VRM alone is
15–18 MB. They download into app storage on first launch, from the same catalog
the desktop build uses, with the same mirror fallback and glTF validation. The
app starts immediately and the character appears when the download lands.

## Permissions

| Permission | Why |
|---|---|
| `INTERNET` | Gemini, and fetching the avatar |
| `RECORD_AUDIO` | hold-to-talk |
| `MODIFY_AUDIO_SETTINGS` | Capacitor requests it alongside the microphone |
| `GET_ACCOUNTS` | lets Play Services name the signed-in account |

The microphone prompt appears the first time you hold the talk button, not at
launch.

## What has not been verified

**No APK was ever built.** The environment this was written in has no Android
SDK, and `dl.google.com` — where the Android Gradle Plugin and the SDK come
from — is blocked by its network policy, so Gradle cannot resolve a single
dependency. `maven.google.com` and `mvnrepository.com` are blocked too.

What that means concretely:

- The TypeScript side is verified: it typechecks, builds, and 106 tests pass,
  including the parity checks above.
- `npx cap sync android` runs cleanly and the project structure is real.
- **`GoogleAuthPlugin.java` has never been compiled.** It is written against
  APIs checked against the Capacitor 8 sources in `node_modules`
  (`Bridge.registerForActivityResult`, `saveCall`, `getSavedCall`,
  `releaseCall`) and Google's documented Authorization API, but a compiler has
  not seen it.
- `playServicesAuthVersion` is pinned to `21.2.0`, chosen without access to
  Google's Maven index. The Authorization API needs ≥ 20.7.0; bump it freely.
- The plugin is Java rather than Kotlin on purpose. The Capacitor template has
  no Kotlin support, and adding it means three build-file changes that could not
  be compile-checked here. Java needed one dependency line.

Expect the first `./gradlew assembleDebug` to be where real problems surface.
