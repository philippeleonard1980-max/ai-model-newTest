import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Application Default Credentials — the zero-configuration way in.
 *
 * `gcloud auth application-default login` performs the whole OAuth dance
 * against Google's own registered client and leaves a file containing a refresh
 * token scoped to `cloud-platform`, which is exactly what Gemini needs. If that
 * file exists the user never has to create a Cloud project, configure a consent
 * screen, or paste a client ID anywhere: we can mint access tokens from it
 * directly.
 *
 * This is read-only. We never write the file, and we never move it.
 */

export interface AdcCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** The project gcloud attributed quota to, when it recorded one. */
  quotaProjectId: string | null;
  path: string;
}

/** Where gcloud writes the file, per platform. */
export function adcPath(): string {
  const explicit = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  if (explicit && existsSync(explicit)) return explicit;

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'gcloud', 'application_default_credentials.json');
  }
  return join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

/**
 * Reads the credentials if they are present and usable. Returns null rather
 * than throwing: a missing or unreadable file simply means this route is not
 * available yet, which is a normal state, not an error.
 */
export function readAdc(): AdcCredentials | null {
  const path = adcPath();
  if (!existsSync(path)) return null;

  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // Service-account keys also live under this name; they need a signed JWT
    // rather than a refresh token, which is out of scope here.
    if (raw['type'] !== 'authorized_user') return null;

    const clientId = typeof raw['client_id'] === 'string' ? raw['client_id'] : '';
    const clientSecret = typeof raw['client_secret'] === 'string' ? raw['client_secret'] : '';
    const refreshToken = typeof raw['refresh_token'] === 'string' ? raw['refresh_token'] : '';
    if (!clientId || !refreshToken) return null;

    return {
      clientId,
      clientSecret,
      refreshToken,
      quotaProjectId:
        typeof raw['quota_project_id'] === 'string' && raw['quota_project_id']
          ? raw['quota_project_id']
          : null,
      path,
    };
  } catch {
    return null;
  }
}

export function hasAdc(): boolean {
  return readAdc() !== null;
}
