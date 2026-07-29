/**
 * Entry point for the `@arcaai/vox/compat` consultation example.
 *
 * The ONE unavoidable v1→v2 change: wrap the tree once in
 * `<ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>`. Everything below it uses
 * the familiar v1 hook names from `@arcaai/vox/compat`.
 *
 * Run: `pnpm --filter live-transcription-example dev` then open `/compat.html`.
 * Configure via Vite env vars (see README).
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ArcaCompatProvider, type V1SdkConfig } from '@arcaai/vox/compat';
import { CompatConsultation } from './compat-consultation';
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'https://api.your-public-domain.com';
const WEBSOCKET_BASE_URL = import.meta.env.VITE_WS_BASE_URL ?? API_BASE_URL.replace(/^http/, 'ws');

const SDK_CONFIG_OPTIONS: V1SdkConfig = {
  // REST origin — the adapter normalizes it to /api/v1 for the v2 hooks and
  // derives the origin back for the /api/smr/... summary shims.
  apiEndpoint: API_BASE_URL,
  websocketUrl: WEBSOCKET_BASE_URL,
  // REQUIRED — there is NO default API key (the adapter throws if omitted).
  credentials: { apiKey: import.meta.env.VITE_API_KEY ?? '' },
  // Enables live backend streaming transcription (omit → local STT).
  sttPipelineId: import.meta.env.VITE_PIPELINE_ID,
  audioSettings: { noiseSuppression: true },
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ArcaCompatProvider options={SDK_CONFIG_OPTIONS}>
      <CompatConsultation
        provider={import.meta.env.VITE_STT_PROVIDER === 'sarvam' ? 'sarvam' : 'azure'}
        apiBaseUrl={API_BASE_URL}
        apiKey={SDK_CONFIG_OPTIONS.credentials?.apiKey}
      />
    </ArcaCompatProvider>
  </React.StrictMode>,
);
