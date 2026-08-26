import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.trademindmz.app',
  appName: 'TradeMindMZ',
  webDir: 'dist',
  // Prod: peker mot den deployede TradeMindMZ-nettsiden
  // For lokal utvikling, kommenter ut server-blokken og bygg dist/ lokalt
  android: {
    backgroundColor: '#0f1117',
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#0f1117',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
  },
};

export default config;
