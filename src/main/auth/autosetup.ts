import { readAdc } from './adc.js';
import { GCLOUD_INSTALL_URL, gcloudInstalled, loginApplicationDefault } from './gcloud.js';
import { getAccessToken } from './google-oauth.js';
import { loadSettings, saveSettings } from '../store/settings.js';
import type { SetupStep } from '@shared/types';

/**
 * Sets Gemini up without sending the user to the Cloud console.
 *
 * The manual route asks someone to create a project, configure a consent
 * screen, create an OAuth client and paste its ID — four screens deep in a
 * console built for platform engineers. Every one of those steps can be done
 * for them: gcloud performs the sign-in against Google's own OAuth client, and
 * the project lookup and API enablement are just REST calls made with the
 * token that sign-in produces.
 */

const RESOURCE_MANAGER = 'https://cloudresourcemanager.googleapis.com/v1/projects';
const SERVICE_USAGE = 'https://serviceusage.googleapis.com/v1';
const GEMINI_SERVICE = 'generativelanguage.googleapis.com';

type Report = (step: SetupStep) => void;

async function googleGet(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** Picks the project to bill Gemini usage to, preferring what gcloud recorded. */
async function findProject(token: string): Promise<string | null> {
  const recorded = readAdc()?.quotaProjectId;
  if (recorded) return recorded;

  const listed = (await googleGet(`${RESOURCE_MANAGER}?pageSize=200`, token)) as {
    projects?: Array<{ projectId?: string; lifecycleState?: string }>;
  };
  const active = (listed.projects ?? []).filter(
    (project) => project.lifecycleState === 'ACTIVE' && project.projectId,
  );
  return active[0]?.projectId ?? null;
}

async function isServiceEnabled(project: string, token: string): Promise<boolean> {
  try {
    const state = (await googleGet(
      `${SERVICE_USAGE}/projects/${project}/services/${GEMINI_SERVICE}`,
      token,
    )) as { state?: string };
    return state.state === 'ENABLED';
  } catch {
    return false;
  }
}

async function enableService(project: string, token: string): Promise<void> {
  const response = await fetch(
    `${SERVICE_USAGE}/projects/${project}/services/${GEMINI_SERVICE}:enable`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    },
  );
  if (!response.ok) {
    throw new Error(`${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

/**
 * Runs the whole thing, reporting each step so the UI can show progress rather
 * than a spinner. Any step may fail with an explanation the user can act on.
 */
export async function runAutoSetup(report: Report): Promise<void> {
  /* 1 ── credentials ────────────────────────────────────────────────── */
  report({ id: 'credentials', label: 'Signing in to Google', state: 'running' });

  if (!readAdc()) {
    if (!gcloudInstalled()) {
      report({
        id: 'credentials',
        state: 'failed',
        label: 'Signing in to Google',
        detail:
          'Automatic setup needs the Google Cloud CLI, which is a single installer and the only thing you have to install by hand.',
        helpUrl: GCLOUD_INSTALL_URL,
      });
      throw new Error('The Google Cloud CLI is not installed.');
    }

    report({
      id: 'credentials',
      state: 'running',
      label: 'Signing in to Google',
      detail: 'Your browser is opening — pick your Google account, then come back.',
    });
    const login = await loginApplicationDefault();
    if (!login.ok || !readAdc()) {
      report({
        id: 'credentials',
        state: 'failed',
        label: 'Signing in to Google',
        detail: login.output.slice(-400) || 'Sign-in did not complete.',
      });
      throw new Error('Google sign-in did not complete.');
    }
  }

  const token = await getAccessToken();
  report({ id: 'credentials', state: 'done', label: 'Signed in to Google' });

  /* 2 ── project ────────────────────────────────────────────────────── */
  report({ id: 'project', state: 'running', label: 'Finding your Google Cloud project' });
  let project: string | null;
  try {
    project = await findProject(token);
  } catch (error) {
    report({
      id: 'project',
      state: 'failed',
      label: 'Finding your Google Cloud project',
      detail: `Could not list your projects (${(error as Error).message}).`,
    });
    throw error;
  }
  if (!project) {
    report({
      id: 'project',
      state: 'failed',
      label: 'Finding your Google Cloud project',
      detail:
        'Your Google account has no Cloud project yet. Create one (it is free) and run setup again.',
      helpUrl: 'https://console.cloud.google.com/projectcreate',
    });
    throw new Error('No Google Cloud project found on this account.');
  }
  report({ id: 'project', state: 'done', label: `Using project “${project}”` });

  /* 3 ── API ────────────────────────────────────────────────────────── */
  report({ id: 'api', state: 'running', label: 'Enabling the Gemini API' });
  try {
    if (!(await isServiceEnabled(project, token))) {
      await enableService(project, token);
    }
    report({ id: 'api', state: 'done', label: 'Gemini API enabled' });
  } catch (error) {
    report({
      id: 'api',
      state: 'failed',
      label: 'Enabling the Gemini API',
      detail:
        `Could not enable it automatically (${(error as Error).message}). ` +
        'You can turn it on yourself with the button below, then run setup again.',
      helpUrl: `https://console.cloud.google.com/apis/library/${GEMINI_SERVICE}?project=${project}`,
    });
    throw error;
  }

  /* 4 ── remember it ────────────────────────────────────────────────── */
  const settings = loadSettings();
  settings.gemini.projectId = project;
  saveSettings(settings);

  /* 5 ── prove it works ─────────────────────────────────────────────── */
  report({ id: 'verify', state: 'running', label: 'Checking Gemini answers' });
  try {
    const models = (await googleGet(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      await getAccessToken(),
    )) as { models?: unknown[] };
    if (!models.models || models.models.length === 0) throw new Error('no models returned');
    report({ id: 'verify', state: 'done', label: 'Gemini is ready' });
  } catch (error) {
    report({
      id: 'verify',
      state: 'failed',
      label: 'Checking Gemini answers',
      detail:
        `Sign-in worked but the first call failed (${(error as Error).message}). ` +
        'Enabling an API can take a minute to propagate — try again shortly.',
    });
    throw error;
  }
}
