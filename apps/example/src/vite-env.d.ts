/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WS_BASE_URL?: string;
  readonly VITE_API_KEY?: string;
  readonly VITE_PIPELINE_ID?: string;
  readonly VITE_STT_PROVIDER?: string;
  readonly VITE_TENANT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
