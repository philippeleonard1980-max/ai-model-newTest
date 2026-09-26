/** Channel names shared by the main process and the preload bridge. */
export const IPC = {
  authState: 'auth:state',
  authSignIn: 'auth:sign-in',
  authSignOut: 'auth:sign-out',
  authSetClient: 'auth:set-client',
  authImportClientFile: 'auth:import-client-file',
  authGetClient: 'auth:get-client',
  authCapability: 'auth:capability',
  authAutoSetup: 'auth:auto-setup',
  authSetupStep: 'auth:setup-step',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  personaGet: 'persona:get',
  personaSet: 'persona:set',
  personaReset: 'persona:reset',

  memoryGet: 'memory:get',
  memorySet: 'memory:set',

  chatSend: 'chat:send',
  chatTranscribe: 'chat:transcribe',
  chatModels: 'chat:models',

  assetsStatus: 'assets:status',
  assetsCatalog: 'assets:catalog',
  assetsInstall: 'assets:install',
  assetsPickLocal: 'assets:pick-local',
  assetsProgress: 'assets:progress',

  shellOpenPath: 'shell:open-path',
  shellOpenExternal: 'shell:open-external',
} as const;

/** Custom protocol used to hand local VRM/VRMA files to the renderer safely. */
export const ASSET_SCHEME = 'kitsune-asset';

/**
 * Builds a renderer-loadable URL for a local asset file. Lives in shared code
 * so the main process and the renderer always agree on the encoding.
 */
export function assetUrl(absolutePath: string): string {
  const encoded = absolutePath.split(/[\\/]/).filter(Boolean).map(encodeURIComponent).join('/');
  return `${ASSET_SCHEME}://local/${encoded}`;
}
