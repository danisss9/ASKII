import { Routes } from '@angular/router';

/**
 * Routes for the three primary surfaces. Pages are lazy standalone
 * components so each ships only what it needs.
 */
export const routes: Routes = [
  { path: '', redirectTo: 'chat', pathMatch: 'full' },
  { path: 'chat', loadComponent: () => import('./pages/chat/chat.page').then((m) => m.ChatPage) },
  {
    path: 'history',
    loadComponent: () => import('./pages/history/history.page').then((m) => m.HistoryPage),
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings.page').then((m) => m.SettingsPage),
  },
];