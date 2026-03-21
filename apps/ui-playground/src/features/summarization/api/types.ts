export interface SmrGenerateRequest {
  prompt: string;
  system_prompt?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  response_format?: { type: 'json_object' | 'text' };
  context?: Record<string, unknown>;
  retry_config?: {
    max_retries?: number;
    retry_delay?: number;
    backoff_factor?: number;
  };
}

export interface AssembledGenerateRequest {
  type: 'pre-summary' | 'summary' | string;
  debug?: boolean;
  stream?: boolean;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  message?: string;
  context_item_ids?: string[];
  prompt_template_id?: string;
  dna_writing_style_id?: string;
  visit_type?: 'new_visit' | 'referral' | '';
}

export interface SmrGenerateResponse {
  task_id: string;
  status: string;
  content: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  latency_ms: number;
  finish_reason: string;
  created_at: string;
}

export interface SmrStreamingResponse {
  task_id: string;
  status: string;
  stream_url: string;
  created_at: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface SmrTaskResponse {
  task_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  content?: string;
  provider?: string;
  model?: string;
  usage?: TokenUsage;
  latency_ms?: number;
  error?: string;
  created_at: string;
  updated_at?: string;
}

export interface SmrProvider {
  name: string;
  models: Array<string | { name?: string; id?: string; size?: string }>;
  is_available: boolean;
  default_model?: string;
}

export interface SmrHealthResponse {
  status: string;
  version?: string;
  uptime_seconds?: number;
  providers: Record<string, { status: string; models?: string[] }>;
}

export interface PreSummaryFormData {
  consultationId: string;
  contextText: string;
  templateId?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface SummaryFormData {
  consultationId: string;
  transcript: string;
  preSummaryText?: string;
  additionalContext?: string;
  templateId?: string;
  dnaStyleId?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  format?: 'SOAP' | 'narrative';
  includeNER?: boolean;
}

export interface SummaryHistoryEntry {
  id: string;
  type: 'pre_summary' | 'summary';
  content: string;
  provider: string;
  model: string;
  processingTimeMs?: number;
  tokenUsage?: TokenUsage;
  dnaStyleId?: string;
  templateId?: string;
  format?: string;
  createdAt: string;
}

export interface DnaStyleInfo {
  id: string;
  name: string;
  description?: string;
  userId?: string;
  formality?: string;
  sentenceLength?: string;
  medicalTermUsage?: string;
  abbreviationStyle?: string;
  createdAt?: string;
}

export type SummarizationTab = 'pre-summary' | 'summary' | 'history' | 'settings';
