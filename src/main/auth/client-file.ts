import { readFileSync } from 'node:fs';
import type { OAuthClientConfig } from '@shared/types';

/**
 * Reads the credentials file the Google Cloud console hands you.
 *
 * Creating an OAuth client ends with a **Download JSON** button, and the file
 * it saves already contains the client ID and secret. Asking someone to open
 * that file, find the right field and paste it into a text box is pure friction
 * — and a mistyped ID fails much later, at sign-in, with an error that does not
 * say which character is wrong. Reading the file instead removes the typing and
 * the class of mistake with it.
 *
 * Google writes the same shape under `installed` (Desktop app) or `web`, so
 * both are accepted; anything else is rejected with what was actually found.
 */
export function parseClientFile(contents: string): OAuthClientConfig {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch {
    throw new Error('That file is not JSON. Download the credentials again with the ⬇ button next to your OAuth client.');
  }

  const root = json as Record<string, unknown>;
  // Check this first: a service-account key also has a `client_id`, just a
  // numeric one, so the generic "that is not a client ID" message would fire
  // instead of the specific one that says which file to download.
  if (root['type'] === 'service_account') {
    throw new Error('That is a service-account key. Create an OAuth client of type "Desktop app" instead and download its JSON.');
  }
  const section = (root['installed'] ?? root['web'] ?? root) as Record<string, unknown>;
  const clientId = typeof section['client_id'] === 'string' ? section['client_id'].trim() : '';
  const clientSecret = typeof section['client_secret'] === 'string' ? section['client_secret'].trim() : '';

  if (!clientId) {
    throw new Error(
      'No "client_id" in that file. It should be the JSON downloaded from the OAuth client you created, not the service-account key or the API-key file.',
    );
  }
  if (!clientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error(`"${clientId}" does not look like a Google OAuth client ID.`);
  }
  return clientSecret ? { clientId, clientSecret } : { clientId };
}

export function readClientFile(path: string): OAuthClientConfig {
  return parseClientFile(readFileSync(path, 'utf8'));
}
