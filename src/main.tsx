import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style/typography.css';
import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
