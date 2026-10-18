import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootToken } from './api/client';
import { App } from './app';
import { applyStoredTheme } from './lib/theme';
import './styles.css';

bootToken();
applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
