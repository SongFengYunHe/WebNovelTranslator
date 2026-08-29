import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';
import { AppProvider } from './contexts/app-context';
import { I18nProvider } from './contexts/i18n-context';
import './styles/styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root not found');

createRoot(container).render(
  <React.StrictMode>
    <I18nProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </I18nProvider>
  </React.StrictMode>
);
