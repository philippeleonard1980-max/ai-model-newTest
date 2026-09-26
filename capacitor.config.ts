import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.kitsune.companion',
  appName: 'Kitsune Companion',
  webDir: 'dist-mobile',
  android: {
    // The avatar is fetched over https on first run; nothing needs cleartext.
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    CapacitorHttp: { enabled: false },
  },
};

export default config;
