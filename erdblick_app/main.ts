import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';
import { AppModule } from './app/app.module';

// TODO: Define interface for Window
(window as Record<string, any>)['CESIUM_BASE_URL'] = '/bundle/cesium/';

platformBrowserDynamic().bootstrapModule(AppModule)
  .catch(err => console.error(err));
