import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { shell, safeStorage } from 'electron';
import { credentialsPath } from '../store/paths.js';
import { readAdc } from './adc.js';
import type { AuthState, OAuthClientConfig } from '@shared/types';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * `cloud-platform` is what both `generativelanguage.googleapis.com` and the
 * Vertex AI endpoint accept as an OAuth bearer scope, so one consent covers
 * either backend. No API key is ever involved.
 */
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

interface StoredCredentials {
  client: OAuthClientConfig;
  refreshToken: string | null;
  accessToken: string | null;
  expiresAt: number | null;
  email: string | null;
}

const EMPTY: StoredCredentials = {
  client: { clientId: '' },
  refreshToken: null,
  accessToken: null,
  expiresAt: null,
  email: null,
};

/* ----------------------------- persistence ----------------------------- */

function readCredentials(): StoredCredentials {
  const path = credentialsPath();
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const raw = readFileSync(path);
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
    return { ...structuredClone(EMPTY), ...(JSON.parse(json) as Partial<StoredCredentials>) };
  } catch {
    // A corrupt or undecryptable store must not brick the app; start clean.
    return structuredClone(EMPTY);
  }
}

function writeCredentials(creds: StoredCredentials): void {
  const json = JSON.stringify(creds);
  const buffer = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8');
  writeFileSync(credentialsPath(), buffer);
}

/* ------------------------------- helpers ------------------------------- */

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function html(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
 body{font-family:system-ui,Segoe UI,sans-serif;background:#12100f;color:#f3e9e0;
      display:grid;place-items:center;height:100vh;margin:0;text-align:center}
 .card{max-width:30rem;padding:2rem}
 h1{font-size:1.4rem;margin:0 0 .5rem}
 p{opacity:.75;line-height:1.5}
 .fox{font-size:3rem}
</style>
<div class="card"><div class="fox">&#129418;</div><h1>${title}</h1><p>${body}</p></div>`;
}

/* -------------------------------- flow --------------------------------- */

/** Resolves once Google redirects back to the loopback listener. */
function awaitAuthorizationCode(
  clientId: string,
  challenge: string,
  state: string,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      const finish = (status: number, page: string, outcome: Error | string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(page);
        server.close();
        if (typeof outcome === 'string') {
          resolve({ code: outcome, redirectUri });
        } else {
          reject(outcome);
        }
      };

      if (error) {
        finish(400, html('Sign-in cancelled', 'You can close this tab and try again.'), new Error(`Google returned "${error}"`));
        return;
      }
      if (!code) {
        finish(400, html('Something went wrong', 'No authorization code came back.'), new Error('No authorization code in callback'));
        return;
      }
      if (returnedState !== state) {
        // Guards against a cross-site request hitting the loopback listener.
        finish(400, html('Something went wrong', 'The sign-in response did not match this request.'), new Error('OAuth state mismatch'));
        return;
      }
      finish(200, html('Rin is connected', 'You can close this tab and go back to the app.'), code);
    });

    let redirectUri = '';
    server.on('error', reject);
    // Port 0 lets the OS pick a free port, which Google permits for the
    // loopback redirect of an installed app.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not open a local port for the sign-in callback'));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const authUrl = new URL(AUTH_ENDPOINT);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', SCOPES.join(' '));
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);
      // `offline` + `consent` are what make Google hand back a refresh token,
      // so the user signs in once rather than every launch.
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('prompt', 'consent');
      void shell.openExternal(authUrl.toString());
    });

    setTimeout(() => {
      server.close();
      reject(new Error('Sign-in timed out after 5 minutes'));
    }, 5 * 60_000).unref();
  });
}

async function postForm(endpoint: string, form: Record<string, string>): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { error_description?: string; error?: string };
      detail = parsed.error_description ?? parsed.error ?? text;
    } catch {
      /* keep raw text */
    }
    throw new Error(`Google rejected the token request (${response.status}): ${detail}`);
  }
  return JSON.parse(text);
}

export function getClientConfig(): OAuthClientConfig | null {
  const creds = readCredentials();
  return creds.client.clientId ? creds.client : null;
}

export function setClientConfig(config: OAuthClientConfig): void {
  const creds = readCredentials();
  const changed = creds.client.clientId !== config.clientId;
  creds.client = { clientId: config.clientId.trim(), clientSecret: config.clientSecret?.trim() || undefined };
  if (changed) {
    // A different OAuth client invalidates any token we were holding.
    creds.refreshToken = null;
    creds.accessToken = null;
    creds.expiresAt = null;
    creds.email = null;
  }
  writeCredentials(creds);
}

export async function signIn(): Promise<AuthState> {
  const creds = readCredentials();
  const clientId = creds.client.clientId;
  if (!clientId) {
    throw new Error(
      'No OAuth client ID configured yet. Add one on the Settings screen — see the README for the two-minute setup.',
    );
  }

  const { verifier, challenge } = makePkcePair();
  const state = base64url(randomBytes(16));
  const { code, redirectUri } = await awaitAuthorizationCode(clientId, challenge, state);

  const form: Record<string, string> = {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  };
  if (creds.client.clientSecret) form['client_secret'] = creds.client.clientSecret;

  const token = (await postForm(TOKEN_ENDPOINT, form)) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  creds.accessToken = token.access_token;
  creds.expiresAt = Date.now() + token.expires_in * 1000;
  if (token.refresh_token) creds.refreshToken = token.refresh_token;
  creds.email = await fetchEmail(token.access_token);
  writeCredentials(creds);
  return toState(creds);
}

async function fetchEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const info = (await response.json()) as { email?: string };
    return info.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns a valid access token, refreshing it when it is within 60 seconds of
 * expiry. Throws with an actionable message when the user must sign in again.
 */
export async function getAccessToken(): Promise<string> {
  const creds = readCredentials();
  if (creds.accessToken && creds.expiresAt && creds.expiresAt - Date.now() > 60_000) {
    return creds.accessToken;
  }
  if (!creds.refreshToken) {
    // Fall back to Application Default Credentials, which the automatic setup
    // produces and which need no configuration inside this app at all.
    const adc = readAdc();
    if (adc) return adcAccessToken(adc);
    throw new Error(
      'Not signed in to Google yet. Open Settings and press “Set up automatically”.',
    );
  }

  const form: Record<string, string> = {
    client_id: creds.client.clientId,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token',
  };
  if (creds.client.clientSecret) form['client_secret'] = creds.client.clientSecret;

  let token: { access_token: string; expires_in: number };
  try {
    token = (await postForm(TOKEN_ENDPOINT, form)) as { access_token: string; expires_in: number };
  } catch (error) {
    // A revoked or expired refresh token is unrecoverable without consent.
    creds.refreshToken = null;
    creds.accessToken = null;
    creds.expiresAt = null;
    writeCredentials(creds);
    throw new Error(
      `Your Google sign-in expired and could not be renewed (${(error as Error).message}). Sign in again from Settings.`,
    );
  }

  creds.accessToken = token.access_token;
  creds.expiresAt = Date.now() + token.expires_in * 1000;
  writeCredentials(creds);
  return token.access_token;
}

/** Cached ADC access token; the file holds only a refresh token. */
let adcToken: { value: string; expiresAt: number } | null = null;

async function adcAccessToken(adc: NonNullable<ReturnType<typeof readAdc>>): Promise<string> {
  if (adcToken && adcToken.expiresAt - Date.now() > 60_000) return adcToken.value;
  const form: Record<string, string> = {
    client_id: adc.clientId,
    refresh_token: adc.refreshToken,
    grant_type: 'refresh_token',
  };
  if (adc.clientSecret) form['client_secret'] = adc.clientSecret;
  const token = (await postForm(TOKEN_ENDPOINT, form)) as {
    access_token: string;
    expires_in: number;
  };
  adcToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
  return token.access_token;
}

export async function signOut(): Promise<AuthState> {
  const creds = readCredentials();
  const revocable = creds.refreshToken ?? creds.accessToken;
  if (revocable) {
    try {
      await postForm(REVOKE_ENDPOINT, { token: revocable });
    } catch {
      // Revocation is best-effort; local credentials are cleared regardless.
    }
  }
  adcToken = null;
  const client = creds.client;
  const cleared: StoredCredentials = { ...structuredClone(EMPTY), client };
  writeCredentials(cleared);
  return toState(cleared);
}

export function forgetEverything(): void {
  const path = credentialsPath();
  if (existsSync(path)) rmSync(path);
}

function toState(creds: StoredCredentials): AuthState {
  const manual = Boolean(creds.refreshToken ?? creds.accessToken);
  const adc = readAdc();
  return {
    // A manually configured client wins if present, but Application Default
    // Credentials alone are enough to be signed in — that is the whole point of
    // the automatic route.
    signedIn: manual || adc !== null,
    method: manual ? 'oauth-client' : adc ? 'adc' : null,
    email: creds.email,
    expiresAt: manual ? creds.expiresAt : null,
    clientConfigured: Boolean(creds.client.clientId) || adc !== null,
  };
}

export function getAuthState(): AuthState {
  return toState(readCredentials());
}
