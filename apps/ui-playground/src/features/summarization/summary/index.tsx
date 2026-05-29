import { Main } from '@/components/layout/main';
import { useAuthStore } from '@/store/auth-store';
import { usePlaygroundStore } from '@/store/playground-store';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Separator } from '@arcaai/ui/separator';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Slider } from '@arcaai/ui/slider';
import { Switch } from '@arcaai/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Textarea } from '@arcaai/ui/textarea';
import { AlertCircle, Calendar, ChevronDown, Dna, FileText, Loader2, Mic, Radio, Search, Settings2, Sparkles, User, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { toast } from 'sonner';
import type { AssembledGenerateRequest, SmrGenerateRequest, SmrGenerateResponse } from '../api';
import { smrClient, useGenerateSummary } from '../api';
import { ImpersonationGuard, ProviderModelSelect, ResultCard } from '../components';
import { SmrStatusBadge } from '../components/smr-status-badge';
import { addToHistory } from '../history';
import { useDoctorContext } from '../hooks/use-doctor-context';

import { useDepartment } from '@/features/admin/api/departments';
import type { PromptTemplate } from '@/features/admin/api/prompts';
import { usePromptTemplates } from '@/features/admin/api/prompts';
import type { DnaReport } from '@/features/dna-writing-style/api/dna-writing-styles';
import { useMyDnaStyle, useDnaStyleByDoctor } from '@/features/dna-writing-style/api/dna-writing-styles';
import { CONTEXT_ENDPOINTS, useStoreApi, useArca, type ContextItem } from '@arcaai/vox';
import { buildAssembledPayload } from '../utils/build-assembled-payload';
import { filterContextItems, type ContextRecency } from '../utils/filter-context-items';

const SAMPLE_TRANSCRIPT = `Doctor: Good morning, Mr. Smith. How have you been since our last visit?
Patient: Good morning, doctor. The chest pain has improved quite a bit since starting the new medication. I still get some discomfort when I climb stairs, but it's much less frequent.
Doctor: That's good to hear. How about the shortness of breath?
Patient: It's better too. I can walk about two blocks now before I need to rest. Before, I could barely walk one.
Doctor: Excellent improvement. Let me check your vitals. Blood pressure is 138 over 85, heart rate 72. That's better than last time. Have you been taking all your medications as prescribed?
Patient: Yes, the aspirin, the statin, and the blood pressure medication. I sometimes forget the evening metformin though.
Doctor: It's important to take the metformin consistently for your diabetes management. Your HbA1c was 7.2 last time, and we want to bring that down. Let me listen to your heart... I hear a slight murmur, grade 2 over 6, which is consistent with what we found before. Lungs are clear.
Patient: Is the murmur something to worry about?
Doctor: It's stable from your last visit, so we'll continue monitoring it. Based on your stress test results showing moderate ischemia, the cardiology team has recommended we proceed with cardiac catheterization. I'd like to schedule that for next week.
Patient: Okay, doctor. What should I expect?
Doctor: It's a minimally invasive procedure. They'll insert a catheter through your wrist or groin to look at your coronary arteries. We'll discuss the details and consent at your pre-procedure visit. For now, continue all your current medications, and please don't forget the evening metformin.`;

const SAMPLE_PRE_SUMMARY = `Pre-Summary — Patient: John Smith, Age: 58
Key History: Persistent chest pain with ST-segment changes on ECG. Stress test positive for moderate ischemia in LAD territory. Cardiac catheterization recommended.
Current Medications: Aspirin 81mg daily, Atorvastatin 40mg, Metformin 500mg BID, Lisinopril 10mg.
Recent Labs: Troponin I: 0.04 (normal), BNP: 150 (mildly elevated), HbA1c: 7.2%, LDL: 145.
Active Problems: Coronary artery disease, Type 2 diabetes (suboptimal control), Hypertension.`;

const SAMPLE_ADDITIONAL = `Lab Results (2026-02-25):
- CBC: WBC 7.2, Hgb 13.8, Plt 245 — all within normal limits
- BMP: Na 140, K 4.2, Cr 1.1, BUN 18, Glucose 142 (fasting)
- Lipid Panel: Total Cholesterol 210, LDL 145, HDL 42, Triglycerides 180
- Liver Function: AST 28, ALT 32, Alk Phos 78 — all normal

Echocardiogram (2026-02-20):
- LVEF 50% (mildly reduced)
- Mild mitral regurgitation
- No pericardial effusion
- Mild LV hypertrophy`;

type InputMode = 'context_item' | 'message';

export default function SummaryPage() {
  const storeApi = useStoreApi();
  const ctx = useDoctorContext();
  const { session } = useArca();
  const debugMode = usePlaygroundStore((s) => s.debugMode);
  const tenantId = useAuthStore((s) => s.tenantId);

  const [inputMode, setInputMode] = useState<InputMode>('context_item');
  const [contextSearchQuery, setContextSearchQuery] = useState('');
  const [contextTypeFilter, setContextTypeFilter] = useState('ALL');
  const [contextRecencyFilter, setContextRecencyFilter] = useState<ContextRecency>('ALL');
  const [selectedContextItems, setSelectedContextItems] = useState<ContextItem[]>([]);
  const [contextLoadingIds, setContextLoadingIds] = useState<string[]>([]);
  const [contextSuggestions, setContextSuggestions] = useState<ContextItem[]>([]);
  const [contextSuggestionsLoading, setContextSuggestionsLoading] = useState(false);
  const [contextSuggestionsLoaded, setContextSuggestionsLoaded] = useState(false);
  const [contextSuggestionsOpen, setContextSuggestionsOpen] = useState(true);
  const [contextSuggestionsError, setContextSuggestionsError] = useState<string | null>(null);
  const [patientFilter, setPatientFilter] = useState<string>('ALL');
  const [consultationMeta, setConsultationMeta] = useState<Record<string, { patientId?: string; appointmentDate?: string }>>({});

  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedDnaStyleId, setSelectedDnaStyleId] = useState('');

  const [transcript, setTranscript] = useState('');
  const [preSummaryText, setPreSummaryText] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');
  const [visitType, setVisitType] = useState<'new_visit' | 'referral' | ''>('');
  const [includeNER, setIncludeNER] = useState(false);
  const [provider, setProvider] = useState('ollama');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState(0.4);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [results, setResults] = useState<SmrGenerateResponse[]>([]);
  const [useStreaming, setUseStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamChunkCount, setStreamChunkCount] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const userDeptId = ctx.primaryDepartmentId ?? '';
  const { data: userDepartment } = useDepartment(userDeptId, { enabled: !!userDeptId });
  const { data: promptTemplatesResponse, isLoading: promptsLoading } = usePromptTemplates(
    tenantId,
    { category: 'SUMMARY' },
    { enabled: !!tenantId && !ctx.requiresImpersonation },
  );
  const { data: doctorDnaStyle, isLoading: dnaLoading } = useDnaStyleByDoctor(ctx.effectiveUserId, {
    enabled: !!ctx.effectiveUserId && !ctx.requiresImpersonation,
  });
  const { data: myDnaStyle } = useMyDnaStyle({ enabled: debugMode && !ctx.requiresImpersonation });

  const generateMutation = useGenerateSummary();

  const promptTemplates: PromptTemplate[] = useMemo(() => {
    const raw = promptTemplatesResponse;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if ('data' in raw && Array.isArray((raw as { data: PromptTemplate[] }).data)) {
      return (raw as { data: PromptTemplate[] }).data;
    }
    return [];
  }, [promptTemplatesResponse]);

  const availableTemplates = useMemo(() => {
    if (!userDeptId) return promptTemplates;
    const deptTemplates = promptTemplates.filter((t) => t.departmentId === userDeptId);
    const globalTemplates = promptTemplates.filter((t) => !t.departmentId);
    return deptTemplates.length > 0 ? [...deptTemplates, ...globalTemplates] : promptTemplates;
  }, [promptTemplates, userDeptId]);

  const selectedTemplate = useMemo(
    () => availableTemplates.find((t) => t.id === selectedTemplateId) ?? null,
    [availableTemplates, selectedTemplateId],
  );

  const dnaReportsList: DnaReport[] = useMemo(() => {
    if (!myDnaStyle) return [];
    return [myDnaStyle];
  }, [myDnaStyle]);

  const activeDnaStyle = useMemo(() => {
    if (debugMode && selectedDnaStyleId) {
      return dnaReportsList.find((d) => d.id === selectedDnaStyleId) ?? doctorDnaStyle;
    }
    return doctorDnaStyle;
  }, [debugMode, selectedDnaStyleId, dnaReportsList, doctorDnaStyle]);

  const currentPromptText = selectedTemplate?.content ?? '';
  const currentDnaText = activeDnaStyle?.styleText ?? '';

  useEffect(() => {
    if (availableTemplates.length > 0 && !selectedTemplateId) {
      setSelectedTemplateId(availableTemplates[0].id);
    }
  }, [availableTemplates, selectedTemplateId]);

  useEffect(() => {
    if (selectedTemplateId && !availableTemplates.some((t) => t.id === selectedTemplateId)) {
      setSelectedTemplateId(availableTemplates[0]?.id ?? '');
    }
  }, [availableTemplates, selectedTemplateId]);

  useEffect(() => {
    if (doctorDnaStyle?.id && !selectedDnaStyleId) {
      setSelectedDnaStyleId(doctorDnaStyle.id);
    }
  }, [doctorDnaStyle?.id, selectedDnaStyleId]);

  const STATIC_CONTEXT_TYPES: Record<string, string> = {
    ALL: 'All types',
    CASE_NOTE: 'Case Note',
    TRANSCRIPT: 'Transcript',
    AUDIO_RECORDING: 'Audio',
    RAW_SUMMARY: 'Summary',
    MODIFIED_SUMMARY: 'Edited Summary',
    PRE_SUMMARY: 'Pre-Summary',
    WORKNOTE: 'Work Note',
    NAMED_ENTITY: 'Named Entity',
    ATTACHMENT: 'Attachment',
  };

  const availableContextTypes = Object.keys(STATIC_CONTEXT_TYPES);

  const consultationPatientMap = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    for (const [cId, meta] of Object.entries(consultationMeta)) {
      map[cId] = meta.patientId;
    }
    return map;
  }, [consultationMeta]);

  const availablePatientIds = useMemo(() => {
    const set = new Set<string>();
    for (const item of contextSuggestions) {
      const pid = consultationPatientMap[item.consultationId];
      if (pid) set.add(pid);
    }
    return Array.from(set).sort();
  }, [contextSuggestions, consultationPatientMap]);

  const formatSourceLabel = useCallback((item: ContextItem): string => {
    if (item.source === 'TRANSCRIPTION') return 'Live Transcription';
    if (item.source === 'AI') return 'AI-generated';
    if (item.source === 'SYSTEM') return 'System';
    return 'Manual Entry';
  }, []);

  const formatItemDate = useCallback((value?: string): string => {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }, []);

  const renderItemMetaRow = useCallback(
    (item: ContextItem, compact = false) => {
      const meta = consultationMeta[item.consultationId];
      const patientId = meta?.patientId;
      const appointmentDate = meta?.appointmentDate;
      const sourceLabel = formatSourceLabel(item);
      const textSize = compact ? 'text-[10px]' : 'text-[11px]';
      return (
        <div className={`text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 ${textSize}`}>
          <span className="flex items-center gap-1">
            <User className="size-3" />
            {patientId ?? 'Unknown patient'}
          </span>
          {appointmentDate && (
            <span className="flex items-center gap-1">
              <Calendar className="size-3" />
              {appointmentDate}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Mic className="size-3" />
            {sourceLabel}
          </span>
          <span>{formatItemDate(item.createdAt)}</span>
        </div>
      );
    },
    [consultationMeta, formatSourceLabel, formatItemDate],
  );

  const filteredContextSuggestions = useMemo(
    () =>
      filterContextItems(contextSuggestions, {
        query: contextSearchQuery,
        type: contextTypeFilter,
        recency: contextRecencyFilter,
        patientId: patientFilter,
        consultationPatientMap,
      }) as ContextItem[],
    [contextSuggestions, contextSearchQuery, contextTypeFilter, contextRecencyFilter, patientFilter, consultationPatientMap],
  );

  const hasManualText = Boolean(debugMode && transcript.trim());
  const hasSelectedContextItems = selectedContextItems.length > 0;
  const selectedContextItemIds = selectedContextItems.map((item) => item.id);

  const loadContextItemContent = useCallback(async (item: ContextItem): Promise<ContextItem | null> => {
    if (item.content?.trim()) {
      return item;
    }

    setContextLoadingIds((prev) => (prev.includes(item.id) ? prev : [...prev, item.id]));

    try {
      const loaded = await smrClient.get<{ id: string; content: string; type?: string }>(`/consultations/_/context/${item.id}`);

      if (!loaded?.content) {
        toast.error(`Context item ${item.id} has no content`);
        return null;
      }

      const enrichedItem = {
        ...item,
        content: loaded.content,
        type: loaded.type ?? item.type,
      } as ContextItem;

      setContextSuggestions((prev) => prev.map((candidate) => (candidate.id === enrichedItem.id ? enrichedItem : candidate)));

      return enrichedItem;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch context item content';
      toast.error(msg);
      return null;
    } finally {
      setContextLoadingIds((prev) => prev.filter((id) => id !== item.id));
    }
  }, []);

  const loadContextSuggestions = useCallback(async () => {
    if (!ctx.effectiveUserId || ctx.requiresImpersonation || contextSuggestionsLoading) {
      return;
    }

    setContextSuggestionsLoading(true);
    setContextSuggestionsError(null);

    try {
      const consultations = await session.listConsultations({
        doctorId: ctx.effectiveUserId,
        page: 1,
        limit: 6,
      });

      const merged: ContextItem[] = [];
      const metaMap: Record<string, { patientId?: string; appointmentDate?: string }> = {};
      for (const consultation of consultations.data ?? []) {
        metaMap[consultation.id] = {
          patientId: consultation.patientId,
          appointmentDate: consultation.appointmentDate,
        };
        await session.load(consultation.id);
        const freshState = storeApi.getState();
        const { apiClient: freshClient, consultation: freshConsultation } = freshState;
        if (!freshClient || !freshConsultation) continue;

        const items = await freshClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.GET(freshConsultation.id));
        merged.push(...(items ?? []));
      }

      const deduped = merged
        .filter((item, index, arr) => arr.findIndex((it) => it.id === item.id) === index)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 40);

      setContextSuggestions(deduped);
      setConsultationMeta(metaMap);
      setContextSuggestionsLoaded(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load context items';
      setContextSuggestionsError(msg);
      setContextSuggestions([]);
    } finally {
      setContextSuggestionsLoading(false);
    }
  }, [contextSuggestionsLoading, ctx.effectiveUserId, ctx.requiresImpersonation, session, storeApi]);

  const toggleContextSelection = useCallback(
    async (item: ContextItem) => {
      const currentlySelected = selectedContextItems.some((selected) => selected.id === item.id);
      if (currentlySelected) {
        setSelectedContextItems((prev) => prev.filter((selected) => selected.id !== item.id));
        return;
      }

      const resolved = await loadContextItemContent(item);
      if (!resolved) return;

      setSelectedContextItems((prev) => {
        if (prev.some((selected) => selected.id === resolved.id)) {
          return prev;
        }
        return [...prev, resolved];
      });
    },
    [loadContextItemContent, selectedContextItems],
  );

  const removeSelectedContextItem = useCallback((itemId: string) => {
    setSelectedContextItems((prev) => prev.filter((item) => item.id !== itemId));
  }, []);

  useEffect(() => {
    setContextSuggestions([]);
    setContextSuggestionsLoaded(false);
    setContextSuggestionsOpen(true);
    setContextSuggestionsError(null);
    setSelectedContextItems([]);
    setContextSearchQuery('');
    setContextTypeFilter('ALL');
    setContextRecencyFilter('ALL');
    setPatientFilter('ALL');
    setConsultationMeta({});
  }, [ctx.effectiveUserId]);

  useEffect(() => {
    if (ctx.effectiveUserId && !ctx.requiresImpersonation && !contextSuggestionsLoaded && !contextSuggestionsLoading) {
      void loadContextSuggestions();
    }
  }, [ctx.effectiveUserId, ctx.requiresImpersonation, contextSuggestionsLoaded, contextSuggestionsLoading, loadContextSuggestions]);

  const buildPromptAndSystem = useCallback(
    (contextMessage: string) => {
      const templateContent = currentPromptText;
      const dnaStyleText = currentDnaText;

      let systemPrompt =
        templateContent ||
        'You are a medical documentation assistant. Generate a comprehensive clinical summary from the provided transcript and context.';
      if (dnaStyleText) systemPrompt += `\n\nApply the following writing style:\n${dnaStyleText}`;
      if (includeNER) systemPrompt += `\n\nAlso extract named medical entities (medications, conditions, procedures) and list them at the end.`;

      let prompt = `Generate a clinical summary from the following transcript:\n\n${contextMessage}`;
      if (preSummaryText) prompt += `\n\n--- Pre-Summary Context ---\n${preSummaryText}`;
      if (additionalContext) prompt += `\n\n--- Additional Context ---\n${additionalContext}`;

      return { prompt, systemPrompt };
    },
    [preSummaryText, additionalContext, currentPromptText, currentDnaText, includeNER],
  );

  const handleStreamingGenerate = useCallback(async () => {
    if (!debugMode && !hasSelectedContextItems) {
      toast.error('Please select at least one context item');
      return;
    }
    if (debugMode && inputMode === 'context_item' && !hasSelectedContextItems) {
      toast.error('Please select at least one context item');
      return;
    }
    if (debugMode && inputMode === 'message' && !hasManualText) {
      toast.error('Please enter a transcript');
      return;
    }

    setIsStreaming(true);
    setStreamingText('');
    setStreamChunkCount(0);
    abortRef.current = new AbortController();
    let accumulated = '';

    try {
      if (debugMode) {
        const body: AssembledGenerateRequest = {
          type: 'summary',
          debug: true,
          stream: true,
          provider: provider || undefined,
          model: model || undefined,
          temperature,
          max_tokens: maxTokens,
        };

        Object.assign(
          body,
          buildAssembledPayload({
            inputMode,
            selectedContextItemIds,
            contextText: transcript,
          }),
        );

        if (selectedTemplateId) body.prompt_template_id = selectedTemplateId;
        if (selectedDnaStyleId) body.dna_writing_style_id = selectedDnaStyleId;
        if (visitType) body.visit_type = visitType;

        const taskRes = await smrClient.post<{
          task_id: string;
          status: string;
          stream_url?: string;
          content?: string;
        }>('/text/generate/assembled', body);

        if (!taskRes.stream_url) {
          if (taskRes.content) {
            accumulated = taskRes.content;
            setStreamingText(accumulated);
          }
          const result: SmrGenerateResponse = {
            task_id: taskRes.task_id,
            status: 'completed',
            content: taskRes.content || '',
            provider: provider || 'ollama',
            model: model || 'default',
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            latency_ms: 0,
            finish_reason: 'stop',
            created_at: new Date().toISOString(),
          };
          setResults((prev) => [result, ...prev]);
          setIsStreaming(false);
          setStreamingText('');
          toast.success('Summary generated (sync)');
          return;
        }

        await smrClient.sse(
          `/text/tasks/${taskRes.task_id}/stream`,
          (data) => {
            try {
              const parsed = JSON.parse(data);
              const text = parsed.content || parsed.text || parsed.delta?.content || '';
              if (text) {
                accumulated += text;
                setStreamingText(accumulated);
                setStreamChunkCount((c) => c + 1);
              }
            } catch {
              /* non-JSON chunk */
            }
          },
          () => {
            if (accumulated) {
              const result: SmrGenerateResponse = {
                task_id: taskRes.task_id,
                status: 'completed',
                content: accumulated,
                provider: provider || 'ollama',
                model: model || 'default',
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                latency_ms: 0,
                finish_reason: 'stop',
                created_at: new Date().toISOString(),
              };
              setResults((prev) => [result, ...prev]);
              addToHistory({
                id: result.task_id,
                type: 'summary',
                content: result.content,
                provider: result.provider,
                model: result.model,
                processingTimeMs: result.latency_ms,
                tokenUsage: result.usage,
                dnaStyle: selectedDnaStyleId || doctorDnaStyle?.id,
                template: selectedTemplateId,
                createdAt: result.created_at,
              });
              toast.success('Streaming summary complete');
            }
            setIsStreaming(false);
            setStreamingText('');
          },
        );
      } else {
        const nonDebugInputPayload = buildAssembledPayload({
          inputMode: 'context_item',
          selectedContextItemIds,
          contextText: transcript,
          selectedContextItems,
          includeMessageForContextItems: true,
        });

        const contextMessage = nonDebugInputPayload.message ?? '';
        if (!contextMessage.trim()) {
          toast.error('None of the selected context items have content');
          setIsStreaming(false);
          return;
        }

        const { prompt, systemPrompt } = buildPromptAndSystem(contextMessage);
        const body: SmrGenerateRequest = {
          prompt,
          system_prompt: systemPrompt,
          provider: provider || 'ollama',
          model: model || undefined,
          temperature: temperature ?? 0.4,
          max_tokens: maxTokens ?? 4096,
          stream: true,
        };

        const taskRes = await smrClient.post<{
          task_id: string;
          status: string;
          stream_url?: string;
          content?: string;
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        }>('/text/generate', body);

        if (!taskRes.stream_url) {
          if (taskRes.content) {
            accumulated = taskRes.content;
            setStreamingText(accumulated);
          }
          const result: SmrGenerateResponse = {
            task_id: taskRes.task_id,
            status: 'completed',
            content: taskRes.content || '',
            provider: provider || 'ollama',
            model: model || 'default',
            usage: taskRes.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            latency_ms: 0,
            finish_reason: 'stop',
            created_at: new Date().toISOString(),
          };
          setResults((prev) => [result, ...prev]);
          setIsStreaming(false);
          setStreamingText('');
          toast.success('Summary generated (sync)');
          return;
        }

        await smrClient.sse(
          `/text/tasks/${taskRes.task_id}/stream`,
          (data) => {
            try {
              const parsed = JSON.parse(data);
              const text = parsed.content || parsed.text || parsed.delta?.content || '';
              if (text) {
                accumulated += text;
                setStreamingText(accumulated);
                setStreamChunkCount((c) => c + 1);
              }
            } catch {
              /* non-JSON chunk */
            }
          },
          () => {
            if (accumulated) {
              const result: SmrGenerateResponse = {
                task_id: taskRes.task_id,
                status: 'completed',
                content: accumulated,
                provider: provider || 'ollama',
                model: model || 'default',
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                latency_ms: 0,
                finish_reason: 'stop',
                created_at: new Date().toISOString(),
              };
              setResults((prev) => [result, ...prev]);
              addToHistory({
                id: result.task_id,
                type: 'summary',
                content: result.content,
                provider: result.provider,
                model: result.model,
                processingTimeMs: result.latency_ms,
                tokenUsage: result.usage,
                dnaStyle: doctorDnaStyle?.id,
                template: selectedTemplateId,
                createdAt: result.created_at,
              });
              toast.success('Streaming summary complete');
            }
            setIsStreaming(false);
            setStreamingText('');
          },
        );
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        toast.error(`Streaming failed: ${message}`);
      }
      setIsStreaming(false);
    }
  }, [
    inputMode,
    hasSelectedContextItems,
    hasManualText,
    selectedContextItemIds,
    selectedContextItems,
    transcript,
    debugMode,
    buildPromptAndSystem,
    provider,
    model,
    temperature,
    maxTokens,
    selectedTemplateId,
    selectedDnaStyleId,
    doctorDnaStyle?.id,
    visitType,
    preSummaryText,
    additionalContext,
  ]);

  const handleGenerate = useCallback(async () => {
    if (!debugMode && !hasSelectedContextItems) {
      toast.error('Please select at least one context item');
      return;
    }
    if (debugMode && inputMode === 'context_item' && !hasSelectedContextItems) {
      toast.error('Please select at least one context item');
      return;
    }
    if (debugMode && inputMode === 'message' && !hasManualText) {
      toast.error('Please enter a transcript');
      return;
    }

    if (debugMode) {
      try {
        const body: AssembledGenerateRequest = {
          type: 'summary',
          debug: true,
          stream: false,
          provider: provider || undefined,
          model: model || undefined,
          temperature,
          max_tokens: maxTokens,
        };

        Object.assign(
          body,
          buildAssembledPayload({
            inputMode,
            selectedContextItemIds,
            contextText: transcript,
          }),
        );

        if (selectedTemplateId) body.prompt_template_id = selectedTemplateId;
        if (selectedDnaStyleId) body.dna_writing_style_id = selectedDnaStyleId;
        if (visitType) body.visit_type = visitType;

        const result = await smrClient.post<SmrGenerateResponse>('/text/generate/assembled', body, { timeout: 120_000 });

        setResults((prev) => [result, ...prev]);
        addToHistory({
          id: result.task_id,
          type: 'summary',
          content: result.content,
          provider: result.provider,
          model: result.model,
          processingTimeMs: result.latency_ms,
          tokenUsage: result.usage,
          dnaStyle: selectedDnaStyleId || doctorDnaStyle?.id,
          template: selectedTemplateId,
          createdAt: result.created_at,
        });
        toast.success('Summary generated successfully');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        toast.error(`Generation failed: ${message}`);
      }
    } else {
      try {
        const dnaStyleText = currentDnaText || undefined;
        const templateContent = currentPromptText || undefined;

        const nonDebugInputPayload = buildAssembledPayload({
          inputMode: 'context_item',
          selectedContextItemIds,
          contextText: transcript,
          selectedContextItems,
          includeMessageForContextItems: true,
        });

        const contextMessage = nonDebugInputPayload.message ?? '';
        if (!contextMessage.trim()) {
          toast.error('None of the selected context items have content');
          return;
        }

        const result = await generateMutation.mutateAsync({
          transcript: contextMessage,
          preSummaryText: preSummaryText || undefined,
          additionalContext: additionalContext || undefined,
          templateContent,
          dnaStyleText,
          includeNER,
          provider,
          model: model || undefined,
          temperature,
          maxTokens,
        });

        setResults((prev) => [result, ...prev]);
        addToHistory({
          id: result.task_id,
          type: 'summary',
          content: result.content,
          provider: result.provider,
          model: result.model,
          processingTimeMs: result.latency_ms,
          tokenUsage: result.usage,
          dnaStyle: doctorDnaStyle?.id,
          template: selectedTemplateId,
          createdAt: result.created_at,
        });
        toast.success('Summary generated successfully');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        toast.error(`Generation failed: ${message}`);
      }
    }
  }, [
    inputMode,
    hasSelectedContextItems,
    hasManualText,
    selectedContextItemIds,
    selectedContextItems,
    transcript,
    debugMode,
    provider,
    model,
    temperature,
    maxTokens,
    selectedTemplateId,
    selectedDnaStyleId,
    doctorDnaStyle?.id,
    visitType,
    preSummaryText,
    additionalContext,
    currentPromptText,
    currentDnaText,
    includeNER,
    generateMutation,
  ]);

  const isGenerating = generateMutation.isPending || isStreaming;

  return (
    <Main>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mb-6">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Summary Generation</h1>
                <p className="text-muted-foreground mt-1">
                  Generate full clinical summaries using transcripts, pre-summaries, templates, and DNA writing styles.
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {debugMode && (
                    <Badge variant="default" className="text-xs">
                      Debug Mode
                    </Badge>
                  )}
                  {ctx.isImpersonated && (
                    <Badge variant="outline" className="text-xs border-amber-300 text-amber-700 dark:text-amber-400">
                      Acting as impersonated user
                    </Badge>
                  )}
                  {userDepartment && (
                    <Badge variant="secondary" className="text-xs">
                      {userDepartment.name || userDepartment.code}
                    </Badge>
                  )}
                </div>
              </div>
              <SmrStatusBadge />
            </div>
          </div>

          {ctx.requiresImpersonation ? (
            <ImpersonationGuard roles={ctx.roles} />
          ) : (
            <div className="grid gap-6 lg:grid-cols-5">
              <div className="flex flex-col gap-4 lg:col-span-3">
                {/* Visit Type (debug mode only) */}
                {debugMode && (
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm">Visit Type</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Select value={visitType} onValueChange={(v: string) => setVisitType(v as typeof visitType)}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select visit type (optional)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="new_visit">New Visit</SelectItem>
                          <SelectItem value="referral">Referral</SelectItem>
                        </SelectContent>
                      </Select>
                    </CardContent>
                  </Card>
                )}

                {/* Input: Context Item ID or Transcript */}
                <Card data-doc="smr-transcript-input">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileText className="size-4 text-blue-500" />
                        <CardTitle className="text-sm">Consultation Transcript</CardTitle>
                      </div>
                      {!debugMode && selectedContextItems.length > 0 && (
                        <Badge variant="secondary" className="text-[10px]">
                          {selectedContextItems.length} selected
                        </Badge>
                      )}
                    </div>
                    {debugMode && (
                      <CardDescription className="text-xs">Load a transcript from context item IDs, or enter text manually.</CardDescription>
                    )}
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {debugMode ? (
                      <Tabs value={inputMode} onValueChange={(v: string) => setInputMode(v as InputMode)}>
                        <TabsList className="w-full">
                          <TabsTrigger value="context_item" className="flex-1">
                            Context Item ID
                          </TabsTrigger>
                          <TabsTrigger value="message" className="flex-1">
                            Manual Message
                          </TabsTrigger>
                        </TabsList>

                        <TabsContent value="context_item" className="flex flex-col gap-3 mt-3">
                          {/* Search & filter controls */}
                          <div className="grid gap-2 sm:grid-cols-6">
                            <div className="sm:col-span-2">
                              <Label htmlFor="smr-context-item-search" className="text-xs">
                                Search Context Items
                              </Label>
                              <div className="relative mt-1">
                                <Search className="text-muted-foreground absolute left-2 top-2.5 size-4" />
                                <Input
                                  id="smr-context-item-search"
                                  placeholder="Search by id or content..."
                                  value={contextSearchQuery}
                                  onChange={(e: ChangeEvent<HTMLInputElement>) => setContextSearchQuery(e.target.value)}
                                  className="pl-8 font-mono text-sm"
                                />
                              </div>
                            </div>
                            <div className="sm:col-span-2">
                              <Label className="text-xs">Patient</Label>
                              <Select value={patientFilter} onValueChange={setPatientFilter}>
                                <SelectTrigger className="mt-1 w-full">
                                  <SelectValue placeholder="All patients" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="ALL">All patients</SelectItem>
                                  {availablePatientIds.map((pid) => (
                                    <SelectItem key={pid} value={pid}>
                                      {pid}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="sm:col-span-1">
                              <Label className="text-xs">Item Type</Label>
                              <Select value={contextTypeFilter} onValueChange={setContextTypeFilter}>
                                <SelectTrigger className="mt-1 w-full">
                                  <SelectValue placeholder="All types" />
                                </SelectTrigger>
                                <SelectContent>
                                  {availableContextTypes.map((itemType) => (
                                    <SelectItem key={itemType} value={itemType}>
                                      {STATIC_CONTEXT_TYPES[itemType] ?? itemType}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="sm:col-span-1">
                              <Label className="text-xs">Recency</Label>
                              <Select
                                value={contextRecencyFilter}
                                onValueChange={(value: string) => setContextRecencyFilter(value as ContextRecency)}
                              >
                                <SelectTrigger className="mt-1 w-full">
                                  <SelectValue placeholder="All dates" />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="ALL">All dates</SelectItem>
                                  <SelectItem value="24H">Last 24 hours</SelectItem>
                                  <SelectItem value="7D">Last 7 days</SelectItem>
                                  <SelectItem value="30D">Last 30 days</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>

                          <div className="flex justify-between mt-2">
                            <Badge variant="secondary" className="text-xs">
                              {selectedContextItems.length} selected
                            </Badge>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => setContextSuggestionsOpen((prev) => !prev)}
                            >
                              {contextSuggestionsOpen ? 'Hide list' : 'Show list'}
                            </Button>
                          </div>

                          {/* Context item suggestions list */}
                          {contextSuggestionsOpen && (
                            <div className="rounded-lg border border-dashed bg-muted/20 p-2">
                              <Label className="mb-2 block text-xs font-medium">Context Item Results</Label>

                              {contextSuggestionsLoading && <p className="text-muted-foreground text-xs">Loading context items...</p>}
                              {!contextSuggestionsLoading && contextSuggestionsError && (
                                <p className="text-destructive text-xs">{contextSuggestionsError}</p>
                              )}
                              {!contextSuggestionsLoading && !contextSuggestionsError && filteredContextSuggestions.length === 0 && (
                                <p className="text-muted-foreground text-xs">No context items match the current filters.</p>
                              )}

                              {!contextSuggestionsLoading && !contextSuggestionsError && filteredContextSuggestions.length > 0 && (
                                <ScrollArea className="h-44">
                                  <div className="flex flex-col gap-1.5 pr-2">
                                    {filteredContextSuggestions.map((item) => {
                                      const selected = selectedContextItems.some((si) => si.id === item.id);
                                      const isLoadingItem = contextLoadingIds.includes(item.id);
                                      const preview = item.content?.trim() ?? '';

                                      return (
                                        <button
                                          key={item.id}
                                          type="button"
                                          className={`rounded border px-2 py-1.5 text-left transition-colors ${selected ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
                                          onClick={() => {
                                            void toggleContextSelection(item);
                                          }}
                                        >
                                          <div className="mb-1 flex items-center justify-between gap-2">
                                            <span className="font-mono text-[11px]">{item.id}</span>
                                            <div className="flex items-center gap-1.5">
                                              <Badge variant="outline" className="text-[10px]">
                                                {item.type ?? 'UNKNOWN'}
                                              </Badge>
                                              {selected && (
                                                <Badge variant="secondary" className="text-[10px]">
                                                  Selected
                                                </Badge>
                                              )}
                                            </div>
                                          </div>
                                          <p className="text-muted-foreground text-xs">
                                            {isLoadingItem
                                              ? 'Loading content...'
                                              : preview.length > 120
                                                ? `${preview.slice(0, 120)}...`
                                                : preview || 'No preview available'}
                                          </p>
                                          <div className="mt-1">{renderItemMetaRow(item, true)}</div>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </ScrollArea>
                              )}
                            </div>
                          )}

                          {/* Selected items preview */}
                          {selectedContextItems.length > 0 && (
                            <div className="flex flex-col gap-2">
                              <Label className="text-xs font-medium">Selected Context Items</Label>
                              {selectedContextItems.map((item) => (
                                <div key={item.id} className="rounded-lg border bg-muted/30 p-3">
                                  <div className="mb-1 flex items-center justify-between gap-2">
                                    <div className="flex min-w-0 items-center gap-2">
                                      <span className="truncate font-mono text-[11px]">{item.id}</span>
                                      <Badge variant="outline" className="text-[10px]">
                                        {item.type ?? 'UNKNOWN'}
                                      </Badge>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <Badge variant="secondary" className="text-[10px] tabular-nums">
                                        {(item.content?.length ?? 0).toLocaleString()} chars
                                      </Badge>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="size-6"
                                        onClick={() => removeSelectedContextItem(item.id)}
                                        aria-label={`Remove ${item.id}`}
                                      >
                                        <X className="size-3.5" />
                                      </Button>
                                    </div>
                                  </div>
                                  <div className="mb-2">{renderItemMetaRow(item, true)}</div>
                                  <ScrollArea className="h-40 rounded border bg-background p-2">
                                    <p className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                                      {item.content?.trim() || 'No content available'}
                                    </p>
                                  </ScrollArea>
                                </div>
                              ))}
                            </div>
                          )}
                        </TabsContent>

                        <TabsContent value="message" className="flex flex-col gap-3 mt-3">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 text-xs"
                              onClick={() => {
                                setTranscript(SAMPLE_TRANSCRIPT);
                                toast.success('Sample transcript loaded');
                              }}
                            >
                              Load Sample
                            </Button>
                          </div>
                          <Textarea
                            rows={12}
                            placeholder="Paste the consultation transcript here..."
                            value={transcript}
                            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTranscript(e.target.value)}
                            className="font-mono text-sm resize-y"
                          />
                        </TabsContent>
                      </Tabs>
                    ) : (
                      /* Production mode: context item selection only (no tabs) */
                      <div className="flex flex-col gap-3">
                        <div className="grid gap-2 sm:grid-cols-6">
                          <div className="sm:col-span-2">
                            <Label htmlFor="smr-context-item-search-prod" className="text-xs">
                              Search Context Items
                            </Label>
                            <div className="relative mt-1">
                              <Search className="text-muted-foreground absolute left-2 top-2.5 size-4" />
                              <Input
                                id="smr-context-item-search-prod"
                                placeholder="Search by id or content..."
                                value={contextSearchQuery}
                                onChange={(e: ChangeEvent<HTMLInputElement>) => setContextSearchQuery(e.target.value)}
                                className="pl-8 font-mono text-sm"
                              />
                            </div>
                          </div>
                          <div className="sm:col-span-2">
                            <Label className="text-xs">Patient</Label>
                            <Select value={patientFilter} onValueChange={setPatientFilter}>
                              <SelectTrigger className="mt-1 w-full">
                                <SelectValue placeholder="All patients" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ALL">All patients</SelectItem>
                                {availablePatientIds.map((pid) => (
                                  <SelectItem key={pid} value={pid}>
                                    {pid}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="sm:col-span-1">
                            <Label className="text-xs">Item Type</Label>
                            <Select value={contextTypeFilter} onValueChange={setContextTypeFilter}>
                              <SelectTrigger className="mt-1 w-full">
                                <SelectValue placeholder="All types" />
                              </SelectTrigger>
                              <SelectContent>
                                {availableContextTypes.map((itemType) => (
                                  <SelectItem key={itemType} value={itemType}>
                                    {STATIC_CONTEXT_TYPES[itemType] ?? itemType}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="sm:col-span-1">
                            <Label className="text-xs">Recency</Label>
                            <Select value={contextRecencyFilter} onValueChange={(value: ContextRecency) => setContextRecencyFilter(value)}>
                              <SelectTrigger className="mt-1 w-full">
                                <SelectValue placeholder="All dates" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="ALL">All dates</SelectItem>
                                <SelectItem value="24H">Last 24 hours</SelectItem>
                                <SelectItem value="7D">Last 7 days</SelectItem>
                                <SelectItem value="30D">Last 30 days</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div>
                          <div className="flex justify-between mt-2">
                            <Badge variant="secondary" className="text-xs">
                              {selectedContextItems.length} selected
                            </Badge>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => setContextSuggestionsOpen((prev) => !prev)}
                            >
                              {contextSuggestionsOpen ? 'Hide list' : 'Show list'}
                            </Button>
                          </div>
                        </div>

                        {contextSuggestionsOpen && (
                          <div className="rounded-lg border border-dashed bg-muted/20 p-2">
                            <Label className="mb-2 block text-xs font-medium">Context Item Results</Label>

                            {contextSuggestionsLoading && <p className="text-muted-foreground text-xs">Loading context items...</p>}
                            {!contextSuggestionsLoading && contextSuggestionsError && (
                              <p className="text-destructive text-xs">{contextSuggestionsError}</p>
                            )}
                            {!contextSuggestionsLoading && !contextSuggestionsError && filteredContextSuggestions.length === 0 && (
                              <p className="text-muted-foreground text-xs">No context items match the current filters.</p>
                            )}

                            {!contextSuggestionsLoading && !contextSuggestionsError && filteredContextSuggestions.length > 0 && (
                              <ScrollArea className="h-44">
                                <div className="flex flex-col gap-1.5 pr-2">
                                  {filteredContextSuggestions.map((item) => {
                                    const selected = selectedContextItems.some((si) => si.id === item.id);
                                    const isLoadingItem = contextLoadingIds.includes(item.id);
                                    const preview = item.content?.trim() ?? '';

                                    return (
                                      <button
                                        key={item.id}
                                        type="button"
                                        className={`rounded border px-2 py-1.5 text-left transition-colors ${selected ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
                                        onClick={() => {
                                          void toggleContextSelection(item);
                                        }}
                                      >
                                        <div className="mb-1 flex items-center justify-between gap-2">
                                          <span className="font-mono text-[11px]">{item.id}</span>
                                          <div className="flex items-center gap-1.5">
                                            <Badge variant="outline" className="text-[10px]">
                                              {item.type ?? 'UNKNOWN'}
                                            </Badge>
                                            {selected && (
                                              <Badge variant="secondary" className="text-[10px]">
                                                Selected
                                              </Badge>
                                            )}
                                          </div>
                                        </div>
                                        <p className="text-muted-foreground text-xs">
                                          {isLoadingItem
                                            ? 'Loading content...'
                                            : preview.length > 120
                                              ? `${preview.slice(0, 120)}...`
                                              : preview || 'No preview available'}
                                        </p>
                                        <div className="mt-1">{renderItemMetaRow(item, true)}</div>
                                      </button>
                                    );
                                  })}
                                </div>
                              </ScrollArea>
                            )}
                          </div>
                        )}

                        {selectedContextItems.length > 0 && (
                          <div className="flex flex-col gap-2">
                            <Label className="text-xs font-medium">Selected Context Items</Label>
                            {selectedContextItems.map((item) => (
                              <div key={item.id} className="rounded-lg border bg-muted/30 p-3">
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <span className="truncate font-mono text-[11px]">{item.id}</span>
                                    <Badge variant="outline" className="text-[10px]">
                                      {item.type ?? 'UNKNOWN'}
                                    </Badge>
                                  </div>
                                  <div className="flex items-center gap-1.5">
                                    <Badge variant="secondary" className="text-[10px] tabular-nums">
                                      {(item.content?.length ?? 0).toLocaleString()} chars
                                    </Badge>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="size-6"
                                      onClick={() => removeSelectedContextItem(item.id)}
                                      aria-label={`Remove ${item.id}`}
                                    >
                                      <X className="size-3.5" />
                                    </Button>
                                  </div>
                                </div>
                                <div className="mb-2">{renderItemMetaRow(item, true)}</div>
                                <ScrollArea className="h-40 rounded border bg-background p-2">
                                  <p className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                                    {item.content?.trim() || 'No content available'}
                                  </p>
                                </ScrollArea>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Pre-Summary Context + Additional Context (non-debug or always) */}
                {!debugMode && (
                  <>
                    <Card data-doc="smr-pre-summary-input">
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <FileText className="size-4 text-indigo-500" />
                            <CardTitle className="text-sm">Pre-Summary Context</CardTitle>
                            <Badge variant="outline" className="text-[10px]">
                              Optional
                            </Badge>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs"
                            onClick={() => {
                              setPreSummaryText(SAMPLE_PRE_SUMMARY);
                              toast.success('Sample pre-summary loaded');
                            }}
                          >
                            Load Sample
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <Textarea
                          rows={6}
                          placeholder="Paste a pre-summary here..."
                          value={preSummaryText}
                          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setPreSummaryText(e.target.value)}
                          className="text-sm resize-y"
                        />
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Sparkles className="size-4 text-amber-500" />
                            <CardTitle className="text-sm">Additional Context</CardTitle>
                            <Badge variant="outline" className="text-[10px]">
                              Optional
                            </Badge>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs"
                            onClick={() => {
                              setAdditionalContext(SAMPLE_ADDITIONAL);
                              toast.success('Sample additional context loaded');
                            }}
                          >
                            Load Sample
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent>
                        <Textarea
                          rows={6}
                          placeholder="Paste additional clinical context here..."
                          value={additionalContext}
                          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setAdditionalContext(e.target.value)}
                          className="text-sm resize-y"
                        />
                      </CardContent>
                    </Card>
                  </>
                )}

                {/* Streaming output */}
                {isStreaming && (
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Radio className="size-4 text-green-500 animate-pulse" />
                          <CardTitle className="text-sm">SSE Streaming Output</CardTitle>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px] tabular-nums">
                            {streamChunkCount} chunks
                          </Badge>
                          <Button variant="destructive" size="sm" className="h-6 text-xs" onClick={() => abortRef.current?.abort()}>
                            Stop
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <ScrollArea className="h-64 rounded-lg border bg-muted/30 p-3">
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">
                          {streamingText}
                          <span className="animate-pulse">▊</span>
                        </p>
                      </ScrollArea>
                    </CardContent>
                  </Card>
                )}

                {results.length > 0 && (
                  <div className="flex flex-col gap-4">
                    <h2 className="text-lg font-semibold">Results ({results.length})</h2>
                    {results.map((r, i) => (
                      <ResultCard
                        key={`${r.task_id}-${i}`}
                        title={`Summary #${results.length - i}`}
                        content={r.content}
                        provider={r.provider}
                        model={r.model}
                        processingTimeMs={r.latency_ms}
                        tokenUsage={r.usage}
                        createdAt={r.created_at}
                        variant="summary"
                      />
                    ))}
                  </div>
                )}
              </div>

              {/* Right column — configuration */}
              <div className="flex flex-col gap-4 lg:col-span-2">
                {/* Prompt Template (read-only) */}
                <Card data-doc="smr-template-selector">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">Summary Template / Prompt</CardTitle>
                      {availableTemplates.length > 0 && (
                        <Badge variant="secondary" className="text-[10px]">
                          {availableTemplates.length} template{availableTemplates.length !== 1 ? 's' : ''}
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="text-xs">
                      {debugMode
                        ? 'Select a prompt template — content is read-only in debug mode'
                        : userDepartment
                          ? `Templates for ${userDepartment.name || userDepartment.code} + global (scoped to active user)`
                          : 'Showing global templates scoped to active user (no department assigned)'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {promptsLoading ? (
                      <Skeleton className="h-9 w-full" />
                    ) : availableTemplates.length === 0 ? (
                      <div className="flex items-center gap-2 rounded-lg border border-dashed p-3">
                        <AlertCircle className="size-4 text-amber-500" />
                        <p className="text-muted-foreground text-xs">
                          No prompt templates found{userDeptId ? ' for your department' : ''}. Create templates in the Admin section.
                        </p>
                      </div>
                    ) : (
                      <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a template" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableTemplates.map((t) => (
                            <SelectItem key={t.id} value={t.id}>
                              <div className="flex items-center gap-2">
                                <span>{t.name}</span>
                                {t.departmentId && (
                                  <Badge variant="outline" className="text-[10px]">
                                    dept
                                  </Badge>
                                )}
                                <Badge variant="secondary" className="text-[10px]">
                                  v{t.currentVersionNumber}
                                </Badge>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}

                    {selectedTemplate && (
                      <div>
                        <ScrollArea className="h-48 rounded-lg border">
                          <div className="p-3">
                            <p className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                              {currentPromptText || 'No content in this template.'}
                            </p>
                          </div>
                        </ScrollArea>
                        {debugMode && selectedTemplate.id && (
                          <p className="text-muted-foreground mt-1 font-mono text-[10px]">ID: {selectedTemplate.id}</p>
                        )}
                        {selectedTemplate.description && <p className="text-muted-foreground mt-1 text-[10px]">{selectedTemplate.description}</p>}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* DNA Writing Style */}
                <Card data-doc="smr-dna-style-panel">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Dna className="size-4 text-green-500" />
                        <CardTitle className="text-sm">DNA Writing Style</CardTitle>
                      </div>
                      {activeDnaStyle && (
                        <Badge variant="secondary" className="text-[10px]">
                          v{activeDnaStyle.currentVersionNumber}
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="text-xs">
                      {debugMode
                        ? 'Select a DNA writing style from the list — read-only in debug mode'
                        : 'Your personalized writing style — applied automatically to generated summaries'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {dnaLoading ? (
                      <Skeleton className="h-40 w-full rounded-lg" />
                    ) : debugMode ? (
                      <>
                        {dnaReportsList.length > 0 ? (
                          <Select value={selectedDnaStyleId} onValueChange={setSelectedDnaStyleId}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select a DNA writing style" />
                            </SelectTrigger>
                            <SelectContent>
                              {dnaReportsList.map((d) => (
                                <SelectItem key={d.id} value={d.id}>
                                  <div className="flex items-center gap-2">
                                    <span>v{d.currentVersionNumber}</span>
                                    {d.id === doctorDnaStyle?.id && (
                                      <Badge variant="outline" className="text-[10px]">
                                        yours
                                      </Badge>
                                    )}
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : !doctorDnaStyle ? (
                          <div className="flex items-center gap-2 rounded-lg border border-dashed p-3">
                            <AlertCircle className="size-4 text-amber-500" />
                            <p className="text-muted-foreground text-xs">No DNA writing styles available.</p>
                          </div>
                        ) : null}
                        {activeDnaStyle && (
                          <>
                            {activeDnaStyle.reportData && (
                              <div className="flex flex-wrap gap-1.5">
                                {activeDnaStyle.reportData.tone && (
                                  <Badge variant="outline" className="text-[10px]">
                                    Tone: {activeDnaStyle.reportData.tone}
                                  </Badge>
                                )}
                                {activeDnaStyle.reportData.formality && (
                                  <Badge variant="outline" className="text-[10px]">
                                    Formality: {activeDnaStyle.reportData.formality}
                                  </Badge>
                                )}
                              </div>
                            )}
                            <ScrollArea className="h-40 rounded-lg border">
                              <div className="p-3">
                                <p className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                                  {currentDnaText || 'No style text defined.'}
                                </p>
                              </div>
                            </ScrollArea>
                            <p className="text-muted-foreground font-mono text-[10px]">ID: {activeDnaStyle.id}</p>
                          </>
                        )}
                      </>
                    ) : !doctorDnaStyle ? (
                      <div className="flex items-center gap-2 rounded-lg border border-dashed p-3">
                        <AlertCircle className="size-4 text-amber-500" />
                        <div>
                          <p className="text-muted-foreground text-xs">No DNA writing style found for your profile.</p>
                          <p className="text-muted-foreground text-[10px]">Generate one from the DNA Writing Style page.</p>
                        </div>
                      </div>
                    ) : (
                      <>
                        {doctorDnaStyle.reportData && (
                          <div className="flex flex-wrap gap-1.5">
                            {doctorDnaStyle.reportData.tone && (
                              <Badge variant="outline" className="text-[10px]">
                                Tone: {doctorDnaStyle.reportData.tone}
                              </Badge>
                            )}
                            {doctorDnaStyle.reportData.formality && (
                              <Badge variant="outline" className="text-[10px]">
                                Formality: {doctorDnaStyle.reportData.formality}
                              </Badge>
                            )}
                            {doctorDnaStyle.reportData.sentenceLength && (
                              <Badge variant="outline" className="text-[10px]">
                                Sentences: {doctorDnaStyle.reportData.sentenceLength}
                              </Badge>
                            )}
                            {doctorDnaStyle.reportData.abbreviationStyle && (
                              <Badge variant="outline" className="text-[10px]">
                                Abbrev: {doctorDnaStyle.reportData.abbreviationStyle}
                              </Badge>
                            )}
                          </div>
                        )}
                        <ScrollArea className="h-40 rounded-lg border">
                          <div className="p-3">
                            <p className="text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                              {currentDnaText || 'No style text defined.'}
                            </p>
                          </div>
                        </ScrollArea>
                      </>
                    )}
                  </CardContent>
                </Card>

                {/* Provider & Model + Settings */}
                <Card data-doc="smr-provider-model">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm">Provider & Model</CardTitle>
                    {debugMode && <CardDescription className="text-xs">Debug mode — select any available provider and model</CardDescription>}
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <ProviderModelSelect provider={provider} model={model} onProviderChange={setProvider} onModelChange={setModel} />

                    <Separator />

                    {!debugMode && (
                      <div className="flex items-center justify-between">
                        <div>
                          <Label className="text-xs">Include NER Extraction</Label>
                          <p className="text-muted-foreground text-[11px]">Extract medications, conditions, procedures</p>
                        </div>
                        <Switch checked={includeNER} onCheckedChange={setIncludeNER} />
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <div>
                        <Label className="flex items-center gap-1.5 text-xs">
                          <Radio className="size-3 text-green-500" />
                          SSE Streaming Mode
                        </Label>
                        <p className="text-muted-foreground text-[11px]">Stream tokens via Server-Sent Events</p>
                      </div>
                      <Switch checked={useStreaming} onCheckedChange={setUseStreaming} />
                    </div>

                    <Separator />

                    <button
                      type="button"
                      className="flex w-full items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setAdvancedOpen(!advancedOpen)}
                    >
                      <Settings2 className="size-3.5" />
                      Advanced Settings
                      <ChevronDown className={`ml-auto size-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {advancedOpen && (
                      <div className="flex flex-col gap-4 rounded-lg border p-3">
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Temperature</Label>
                            <span className="text-muted-foreground font-mono text-xs">{temperature.toFixed(2)}</span>
                          </div>
                          <Slider
                            value={[temperature]}
                            onValueChange={(values: number[]) => setTemperature(values[0] ?? temperature)}
                            min={0}
                            max={2}
                            step={0.05}
                          />
                        </div>

                        <div className="flex flex-col gap-2">
                          <Label htmlFor="max-tokens" className="text-xs">
                            Max Tokens
                          </Label>
                          <Input
                            id="max-tokens"
                            type="number"
                            min={256}
                            max={16384}
                            value={maxTokens}
                            onChange={(e: ChangeEvent<HTMLInputElement>) => setMaxTokens(Number(e.target.value) || 2048)}
                            className="h-8 text-xs"
                          />
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <div data-doc="smr-generate-button">
                  <Button
                    className="w-full"
                    size="lg"
                    onClick={useStreaming ? handleStreamingGenerate : handleGenerate}
                    disabled={
                      isGenerating ||
                      (debugMode ? (inputMode === 'context_item' ? !hasSelectedContextItems : !hasManualText) : !hasSelectedContextItems)
                    }
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        {isStreaming ? 'Streaming Summary…' : 'Generating Summary…'}
                      </>
                    ) : (
                      <>
                        {useStreaming ? <Radio className="mr-2 size-4" /> : <Sparkles className="mr-2 size-4" />}
                        {useStreaming ? 'Stream Summary (SSE)' : 'Generate Summary'}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Main>
  );
}
