/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_API_KEY?: string;
  readonly VITE_TENANT_ID?: string;
  readonly VITE_PIPELINE_ID?: string;
  readonly VITE_LANGUAGE_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
