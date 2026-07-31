/**
 * Entry point for the HOPE compat playground (TASK-586 Lane F).
 *
 * A standalone `@arcaai/vox/compat` consumer modeling a real v1-migrating
 * developer's app: a config panel (apiEndpoint/apiKey/tenantId/pipelineId),
 * a live-transcription session, and the end-user ON/OFF STT provider toggle.
 * See ./App.tsx and README.md.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
