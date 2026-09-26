import { registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { AuthState, OAuthClientConfig } from '@shared/types';

/**
 * Android sign-in.
 *
 * The desktop build runs a PKCE loopback flow, which Android does not allow:
 * Google restricted custom URI schemes for new Android OAuth clients, and the
 * device-code flow's scope allowlist excludes `cloud-platform`. What remains —
 * and what Google points at — is Play Services' Authorization API, which hands
 * the app an access token directly with no redirect, no client secret and no
 * server in the middle.
 *
 * Tokens last about an hour. There is no refresh token, and we do not want one:
 * re-authorizing is silent once the user has granted the scope, so the native
 * side simply asks again and only shows UI if consent is genuinely required.
 */
export interface GoogleAuthPlugin {
  /** Authorizes, showing consent UI only if needed. */
  authorize(options: { scopes: string[]; silent?: boolean }): Promise<{
    accessToken: string | null;
    /** Epoch millis; absent when the platform does not say. */
    expiresAt?: number | null;
    email?: string | null;
    /** True when consent UI is required but `silent` was requested. */
    needsConsent?: boolean;
  }>;
  /** Forgets the local grant and clears cached tokens. */
  signOut(): Promise<void>;
}

const GoogleAuth = registerPlugin<GoogleAuthPlugin>('GoogleAuth');

/** Same scope set as the desktop build; covers both Gemini backends. */
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
];

const EMAIL_KEY = 'auth.email';
const TOKEN_KEY = 'auth.token';
const EXPIRY_KEY = 'auth.expiresAt';

/** Refresh this far before nominal expiry so a call never races the clock. */
const EXPIRY_MARGIN_MS = 60_000;

async function remember(token: string, expiresAt: number | null, email: string | null): Promise<void> {
  await Preferences.set({ key: TOKEN_KEY, value: token });
  await Preferences.set({ key: EXPIRY_KEY, value: String(expiresAt ?? 0) });
  if (email) await Preferences.set({ key: EMAIL_KEY, value: email });
}

async function cached(): Promise<{ token: string | null; expiresAt: number; email: string | null }> {
  const [token, expiry, email] = await Promise.all([
    Preferences.get({ key: TOKEN_KEY }),
    Preferences.get({ key: EXPIRY_KEY }),
    Preferences.get({ key: EMAIL_KEY }),
  ]);
  return {
    token: token.value ?? null,
    expiresAt: Number(expiry.value ?? 0),
    email: email.value ?? null,
  };
}

export async function getAuthState(): Promise<AuthState> {
  const { token, expiresAt, email } = await cached();
  return {
    signedIn: Boolean(token),
    // Android always goes through Play Services rather than a pasted client.
    method: token ? 'oauth-client' : null,
    email,
    expiresAt: expiresAt || null,
    // Android registers its OAuth client by package name and signing
    // certificate, not by a client ID pasted into the app, so there is nothing
    // for the user to configure here.
    clientConfigured: true,
  };
}

export async function signIn(): Promise<AuthState> {
  const result = await GoogleAuth.authorize({ scopes: SCOPES });
  if (!result.accessToken) {
    throw new Error('Google did not return an access token. Check that Play Services is available and try again.');
  }
  await remember(result.accessToken, result.expiresAt ?? null, result.email ?? null);
  return getAuthState();
}

export async function signOut(): Promise<AuthState> {
  try {
    await GoogleAuth.signOut();
  } catch {
    // Clearing locally still matters even if the native call failed.
  }
  await Promise.all([
    Preferences.remove({ key: TOKEN_KEY }),
    Preferences.remove({ key: EXPIRY_KEY }),
    Preferences.remove({ key: EMAIL_KEY }),
  ]);
  return getAuthState();
}

/**
 * Returns a usable access token, re-authorizing silently when the cached one is
 * close to expiry. Only throws when the user genuinely has to tap something.
 */
export async function getAccessToken(): Promise<string> {
  const { token, expiresAt } = await cached();
  if (token && expiresAt - Date.now() > EXPIRY_MARGIN_MS) return token;

  const result = await GoogleAuth.authorize({ scopes: SCOPES, silent: true });
  if (result.accessToken) {
    await remember(result.accessToken, result.expiresAt ?? null, result.email ?? null);
    return result.accessToken;
  }
  throw new Error(
    result.needsConsent
      ? 'Your Google sign-in needs renewing. Open Settings and tap Sign in with Google.'
      : 'Not signed in to Google yet. Open Settings and sign in.',
  );
}

/**
 * The desktop build asks the user for an OAuth client ID. On Android the client
 * is identified by the app signature instead, so these exist only to satisfy
 * the shared API and are deliberately inert.
 */
export function getClientConfig(): OAuthClientConfig | null {
  return null;
}

export async function setClientConfig(): Promise<AuthState> {
  return getAuthState();
}
