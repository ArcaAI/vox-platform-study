import React from 'react';
import { LiveTranscriptionDemo } from './LiveTranscriptionDemo';

export const App: React.FC = () => {
  return (
    <div>
      {/*
        TASK-865 / TASK-985 — selection is the published ASR AGENT's slug, or
        nothing at all. Leaving `VITE_AGENT_SLUG` unset is the recommended
        setup: the tenant's own agent assignment then decides, which is what a
        clinic actually wants. `VITE_PIPELINE_ID` is the deprecated selector,
        kept only so an existing .env keeps working.
      */}
      <LiveTranscriptionDemo
        apiBaseUrl={import.meta.env.VITE_API_BASE_URL ?? 'https://api.your-public-domain.com'}
        agentSlug={import.meta.env.VITE_AGENT_SLUG}
        pipelineId={import.meta.env.VITE_PIPELINE_ID}
        apiKey={import.meta.env.VITE_API_KEY}
        tenantId={import.meta.env.VITE_TENANT_ID}
      />
    </div>
  );
};
