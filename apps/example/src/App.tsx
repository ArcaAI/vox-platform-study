import React from 'react';
import { LiveTranscriptionDemo } from './LiveTranscriptionDemo';

export const App: React.FC = () => {
  return (
    <div>
      <LiveTranscriptionDemo
        apiBaseUrl={import.meta.env.VITE_API_BASE_URL ?? 'https://api.your-public-domain.com'}
        pipelineId={import.meta.env.VITE_PIPELINE_ID}
        authToken={import.meta.env.VITE_AUTH_TOKEN}
        tenantId={import.meta.env.VITE_TENANT_ID}
      />
    </div>
  );
};
