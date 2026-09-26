import { describe, expect, it } from 'vitest';
import { parseClientFile } from '../src/main/auth/client-file';

/** The shape the Cloud console downloads for a Desktop-app OAuth client. */
const DESKTOP = JSON.stringify({
  installed: {
    client_id: '1234567890-abcdefg.apps.googleusercontent.com',
    project_id: 'kitsune-demo',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    client_secret: 'GOCSPX-notarealsecret',
    redirect_uris: ['http://localhost'],
  },
});

describe('parseClientFile', () => {
  it('reads the desktop-app file the console downloads', () => {
    expect(parseClientFile(DESKTOP)).toEqual({
      clientId: '1234567890-abcdefg.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-notarealsecret',
    });
  });

  it('reads a web-client file, which has the same shape under another key', () => {
    const web = JSON.stringify({
      web: { client_id: '99-x.apps.googleusercontent.com', client_secret: 's' },
    });
    expect(parseClientFile(web)).toEqual({
      clientId: '99-x.apps.googleusercontent.com',
      clientSecret: 's',
    });
  });

  it('accepts a client with no secret, since the flow uses PKCE', () => {
    const bare = JSON.stringify({ installed: { client_id: '7-y.apps.googleusercontent.com' } });
    expect(parseClientFile(bare)).toEqual({ clientId: '7-y.apps.googleusercontent.com' });
  });

  it('names the likely mistake when handed a service-account key', () => {
    // Downloading the wrong thing from the console is the common error, and
    // "invalid client" at sign-in would not say which file was wrong.
    const key = JSON.stringify({
      type: 'service_account',
      project_id: 'kitsune-demo',
      client_id: '110000000000000000000',
      private_key: '-----BEGIN PRIVATE KEY-----',
    });
    expect(() => parseClientFile(key)).toThrow(/service-account|Desktop app/i);
  });

  it('rejects an API-key file rather than storing something unusable', () => {
    expect(() => parseClientFile(JSON.stringify({ api_key: 'AIzaSy-nope' }))).toThrow(/client_id/i);
  });

  it('explains a file that is not JSON at all', () => {
    expect(() => parseClientFile('<!doctype html><title>Sign in</title>')).toThrow(/not JSON/i);
  });

  it('rejects an id that is not a Google OAuth client id', () => {
    const wrong = JSON.stringify({ installed: { client_id: 'my-app-id' } });
    expect(() => parseClientFile(wrong)).toThrow(/does not look like/i);
  });
});
