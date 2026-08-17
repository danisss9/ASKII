import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';

bootstrapApplication(AppComponent, {
  providers: [
    provideIonicAngular({ mode: 'md' }),
    provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'enabled' })),
  ],
}).catch((err) => console.error(err));