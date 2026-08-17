import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.askii.app',
  appName: 'ASKII',
  // Angular's `application` builder emits to <outputPath>/browser — point
  // Capacitor's webDir there so `cap sync android` copies the web build.
  webDir: 'www/browser',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    // Filled in by the native plugins under src-plugins (askii-http,
    // askii-browser, askii-screen). TypeScript-only placeholders live in
    // src/app/plugins; the Kotlin implementations are added in later phases.
  },
};

export default config;