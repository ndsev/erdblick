import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { AppModule } from './app.module';

// Window interface with additional Global variables.
// Required so that Cesium can find its bundled resources.
declare global {
    interface Window {
        CESIUM_BASE_URL: string
    }
}
window.CESIUM_BASE_URL = 'bundle/cesium/';

// Apply persisted dark mode before Angular bootstraps to avoid flicker
(() => {
    try {
        const DARK_MODE_KEY = 'ui.darkMode';
        const DARK_MODE_CLASS = 'erdblick-dark';
        const PREFERS_DARK_QUERY = '(prefers-color-scheme: dark)';
        const stored = (localStorage.getItem(DARK_MODE_KEY) as 'off' | 'on' | 'auto' | null) ?? 'auto';
        const root = document.documentElement;
        const shouldDark = stored === 'on' || (stored === 'auto' && window.matchMedia(PREFERS_DARK_QUERY).matches);
        if (shouldDark) {
            root.classList.add(DARK_MODE_CLASS);
        } else {
            root.classList.remove(DARK_MODE_CLASS);
        }
    } catch (e) {
        console.error("Error getting dark mode", e);
    }
})();

platformBrowserDynamic().bootstrapModule(AppModule)
  .catch(err => console.error(err));
