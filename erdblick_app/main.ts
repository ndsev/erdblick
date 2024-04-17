import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { AppModule } from './app/app.module';

// Window interface with additional Global variables.
// Required so that Cesium can find its bundled resources.
declare global {
    interface Window {
        CESIUM_BASE_URL: string
    }
}
window.CESIUM_BASE_URL = '/bundle/cesium/';

platformBrowserDynamic().bootstrapModule(AppModule)
  .catch(err => console.error(err));
