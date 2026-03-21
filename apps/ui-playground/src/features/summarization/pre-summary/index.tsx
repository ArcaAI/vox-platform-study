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
import { Link } from '@tanstack/react-router';
import { AlertCircle, ArrowRight, ChevronDown, Dna, FileText, Loader2, Radio, Search, Settings2, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { AssembledGenerateRequest, SmrGenerateResponse } from '../api';
import { smrClient, useGeneratePreSummary } from '../api';
import { ImpersonationGuard, ProviderModelSelect, ResultCard } from '../components';
import { SmrStatusBadge } from '../components/smr-status-badge';
import { addToHistory } from '../history';
import { useDoctorContext } from '../hooks/use-doctor-context';

import { useDepartment } from '@/features/admin/api/departments';
import type { PromptTemplate } from '@/features/admin/api/prompts';
import { usePromptTemplates } from '@/features/admin/api/prompts';
import type { DnaReport } from '@/features/dna-writing-style/api/dna-writing-styles';
import {
  useMyDnaStyle,
  useDnaStyleByDoctor,
} from '@/features/dna-writing-style/api/dna-writing-styles';
import { CONTEXT_ENDPOINTS, useAgenticStore, useArca, type ContextItem } from '@arcaai/vox';
import { buildAssembledPayload } from '../utils/build-assembled-payload';
import { filterContextItems, type ContextRecency } from '../utils/filter-context-items';

type InputMode = 'context_item' | 'message';

const SAMPLE_CONTEXTS = {
  followup: `Patient: John Smith, Age: 58, MRN: MRN-2024-0892
Previous Visit (2026-01-15): Presented with persistent chest pain, ECG showed ST-segment changes. Started on aspirin 81mg daily, atorvastatin 40mg. Referred for stress test.
Previous Visit (2026-02-01): Stress test showed moderate ischemia in LAD territory. Cardiology consult recommended cardiac catheterization.
Lab Results (2026-02-10): Troponin I: 0.04 ng/mL (normal), BNP: 150 pg/mL (mildly elevated), HbA1c: 7.2%, LDL: 145 mg/dL.
Current Medications: Aspirin 81mg, Atorvastatin 40mg, Metformin 500mg BID, Lisinopril 10mg.`,
  newpatient: `Patient: Sarah Johnson, Age: 34, MRN: MRN-2026-1205
Referral from Dr. Patel (Family Medicine): Patient referred for evaluation of recurrent headaches, 3-month history.
Referral Notes: Migraine-type headaches, 3-4 episodes per week, associated with nausea and photophobia. Failed trial of sumatriptan. Family history of migraine (mother). No red flag symptoms.
Previous Imaging: CT Head (2026-01-20) - Normal. No intracranial abnormality.
Current Medications: Ibuprofen 400mg PRN, Sumatriptan 50mg (discontinued due to chest tightness).`,
  examination: `Examination Results - Patient: Robert Chen, Age: 72
Vitals: BP 158/92, HR 78, Temp 37.1°C, SpO2 96% on RA, BMI 28.4
General: Alert, oriented x3, no acute distress
HEENT: PERRLA, no JVD, thyroid non-palpable
Cardiovascular: Regular rate and rhythm, Grade II/VI systolic murmur at apex, no S3/S4
Respiratory: Clear to auscultation bilaterally, no wheezes or crackles
Abdomen: Soft, non-tender, no hepatosplenomegaly
Extremities: 1+ bilateral pedal edema, peripheral pulses 2+ bilaterally
Neurological: CN II-XII intact, strength 5/5 all extremities`,
};

export default function PreSummaryPage() {
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
  const [contextSuggestionsOpen, setContextSuggestionsOpen] = useState(false);
  const [contextSuggestionsError, setContextSuggestionsError] = useState<string | null>(null);
  const [contextText, setContextText] = useState('');
  const [visitType, setVisitType] = useState<'new_visit' | 'referral' | ''>('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedDnaStyleId, setSelectedDnaStyleId] = useState('');

  const [provider, setProvider] = useState('ollama');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState(0.3);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [useStreaming, setUseStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamChunkCount, setStreamChunkCount] = useState(0);
  const [results, setResults] = useState<SmrGenerateResponse[]>([]);

  const userDeptId = ctx.primaryDepartmentId ?? '';
  const { data: userDepartment } = useDepartment(userDeptId, { enabled: !!userDeptId });
  const { data: promptTemplatesResponse, isLoading: promptsLoading } = usePromptTemplates(
    tenantId,
    undefined,
    { enabled: !!tenantId && !ctx.requiresImpersonation },
  );
  const { data: doctorDnaStyle, isLoading: dnaLoading } = useDnaStyleByDoctor(
    ctx.effectiveUserId,
    { enabled: !!ctx.effectiveUserId && !ctx.requiresImpersonation },
  );
  const { data: myDnaStyle } = useMyDnaStyle(
    { enabled: debugMode && !ctx.requiresImpersonation },
  );

  const generateMutation = useGeneratePreSummary();

  const promptTemplates: PromptTemplate[] = useMemo(() => {
    const raw = promptTemplatesResponse;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if ('data' in raw && Array.isArray((raw as { data: PromptTemplate[] }).data)) {
      return (raw as { data: PromptTemplate[] }).data;
    }
    return [];
  }, [promptTemplatesResponse]);

  const deptScopedTemplates = useMemo(() => {
    if (!userDeptId) return promptTemplates.filter((t) => !t.departmentId);
    const deptTemplates = promptTemplates.filter((t) => t.departmentId === userDeptId);
    const globalTemplates = promptTemplates.filter((t) => !t.departmentId);
    return deptTemplates.length > 0 ? [...deptTemplates, ...globalTemplates] : promptTemplates;
  }, [promptTemplates, userDeptId]);

  const availableTemplates = useMemo(() => {
    const preSummaryTagged = deptScopedTemplates.filter(
      (t) => t.category === 'PRE_SUMMARY' || t.tags?.some((tag) => tag.toLowerCase().includes('pre-summary')),
    );

    const visitTypeTemplateId =
      visitType === 'new_visit'
        ? userDepartment?.newPatientPromptId
        : visitType === 'referral'
          ? userDepartment?.revisitPromptId
          : userDepartment?.preSummaryPromptId;

    const prioritizedIds = [visitTypeTemplateId, userDepartment?.preSummaryPromptId].filter((id): id is string => Boolean(id));

    const prioritizedTemplates = prioritizedIds
      .map((id) => deptScopedTemplates.find((t) => t.id === id) ?? null)
      .filter((t): t is PromptTemplate => Boolean(t));

    const merged = [...prioritizedTemplates, ...preSummaryTagged];
    if (merged.length > 0) {
      return merged.filter((t, index, arr) => arr.findIndex((it) => it.id === t.id) === index);
    }
    return deptScopedTemplates;
  }, [deptScopedTemplates, userDepartment?.newPatientPromptId, userDepartment?.revisitPromptId, userDepartment?.preSummaryPromptId, visitType]);

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

  const selectedTemplate = useMemo(
    () => availableTemplates.find((t) => t.id === selectedTemplateId) ?? null,
    [availableTemplates, selectedTemplateId],
  );

  const availableContextTypes = useMemo(() => {
    const typeSet = new Set(contextSuggestions.map((item) => item.type).filter((itemType): itemType is string => Boolean(itemType)));
    return ['ALL', ...Array.from(typeSet).sort()];
  }, [contextSuggestions]);

  const filteredContextSuggestions = useMemo(
    () =>
      filterContextItems(contextSuggestions, {
        query: contextSearchQuery,
        type: contextTypeFilter,
        recency: contextRecencyFilter,
      }) as ContextItem[],
    [contextSuggestions, contextSearchQuery, contextTypeFilter, contextRecencyFilter],
  );

  const hasManualText = Boolean(debugMode && contextText.trim());
  const hasSelectedContextItems = selectedContextItems.length > 0;
  const selectedContextItemIds = selectedContextItems.map((item) => item.id);

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
      for (const consultation of consultations.data ?? []) {
        await session.load(consultation.id);
        const freshState = useAgenticStore.getState();
        const { apiClient: freshClient, consultation: freshConsultation } = freshState;
        if (!freshClient || !freshConsultation) continue;

        const [caseNotes, transcriptions] = await Promise.all([
          freshClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.CASE_NOTES(freshConsultation.id)),
          freshClient.get<ContextItem[]>(CONTEXT_ENDPOINTS.TRANSCRIPTIONS(freshConsultation.id)),
        ]);
        merged.push(...(caseNotes ?? []), ...(transcriptions ?? []));
      }

      const deduped = merged
        .filter((item, index, arr) => arr.findIndex((it) => it.id === item.id) === index)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 40);

      setContextSuggestions(deduped);
      setContextSuggestionsLoaded(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load context items';
      setContextSuggestionsError(msg);
      setContextSuggestions([]);
    } finally {
      setContextSuggestionsLoading(false);
    }
  }, [contextSuggestionsLoading, ctx.effectiveUserId, ctx.requiresImpersonation, session]);

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
    setContextSuggestionsOpen(false);
    setContextSuggestionsError(null);
    setSelectedContextItems([]);
    setContextSearchQuery('');
    setContextTypeFilter('ALL');
    setContextRecencyFilter('ALL');
  }, [ctx.effectiveUserId]);

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
      toast.error('Please enter a message');
      return;
    }

    if (debugMode) {
      try {
        const body: AssembledGenerateRequest = {
          type: 'pre-summary',
          debug: true,
          stream: useStreaming,
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
            contextText,
          }),
        );

        if (selectedTemplateId) body.prompt_template_id = selectedTemplateId;
        if (selectedDnaStyleId) body.dna_writing_style_id = selectedDnaStyleId;
        if (visitType) body.visit_type = visitType;

        if (useStreaming) {
          setIsStreaming(true);
          setStreamingText('');
          setStreamChunkCount(0);

          const taskRes = await smrClient.post<{
            task_id: string;
            status: string;
            stream_url?: string;
            content?: string;
            _debug?: Record<string, unknown>;
          }>('/text/generate/assembled', body);

          if (!taskRes.stream_url) {
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
            toast.success('Pre-summary generated (sync)');
            return;
          }

          let accumulated = '';
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
                  type: 'pre_summary',
                  content: result.content,
                  provider: result.provider,
                  model: result.model,
                  processingTimeMs: result.latency_ms,
                  tokenUsage: result.usage,
                  dnaStyle: selectedDnaStyleId || doctorDnaStyle?.id,
                  template: selectedTemplateId,
                  createdAt: result.created_at,
                });
                toast.success('Streaming pre-summary complete');
              }
              setIsStreaming(false);
              setStreamingText('');
            },
          );
        } else {
          const result = await smrClient.post<SmrGenerateResponse>('/text/generate/assembled', body, { timeout: 120_000 });

          setResults((prev) => [result, ...prev]);
          addToHistory({
            id: result.task_id,
            type: 'pre_summary',
            content: result.content,
            provider: result.provider,
            model: result.model,
            processingTimeMs: result.latency_ms,
            tokenUsage: result.usage,
            dnaStyle: selectedDnaStyleId || doctorDnaStyle?.id,
            template: selectedTemplateId,
            createdAt: result.created_at,
          });
          toast.success('Pre-summary generated successfully');
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          toast.error(`Generation failed: ${message}`);
        }
        setIsStreaming(false);
      }
    } else {
      try {
        let templateContent = currentPromptText;
        if (!templateContent) {
          templateContent =
            'You are a medical documentation assistant. Generate a concise pre-summary from the provided clinical context. Focus on key findings, diagnoses, medications, and treatment plans.';
        }

        const dnaStyleText = currentDnaText || undefined;
        if (dnaStyleText) {
          templateContent += `\n\nApply the following writing style:\n${dnaStyleText}`;
        }

        const nonDebugInputPayload = buildAssembledPayload({
          inputMode: 'context_item',
          selectedContextItemIds,
          contextText,
          selectedContextItems,
          includeMessageForContextItems: true,
        });

        const contextMessage = nonDebugInputPayload.message ?? '';
        if (!contextMessage.trim()) {
          toast.error('None of the selected context items have content');
          return;
        }

        const result = await generateMutation.mutateAsync({
          contextText: contextMessage,
          templateContent,
          provider,
          model: model || undefined,
          temperature,
          maxTokens,
        });

        setResults((prev) => [result, ...prev]);
        addToHistory({
          id: result.task_id,
          type: 'pre_summary',
          content: result.content,
          provider: result.provider,
          model: result.model,
          processingTimeMs: result.latency_ms,
          tokenUsage: result.usage,
          dnaStyle: doctorDnaStyle?.id,
          template: selectedTemplateId,
          createdAt: result.created_at,
        });
        toast.success('Pre-summary generated successfully');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        toast.error(`Generation failed: ${message}`);
      }
    }
  }, [
    debugMode,
    inputMode,
    hasSelectedContextItems,
    hasManualText,
    useStreaming,
    provider,
    model,
    temperature,
    maxTokens,
    selectedContextItemIds,
    contextText,
    selectedTemplateId,
    selectedDnaStyleId,
    doctorDnaStyle?.id,
    visitType,
    currentPromptText,
    currentDnaText,
    generateMutation,
    selectedContextItems,
  ]);

  const loadSample = (key: keyof typeof SAMPLE_CONTEXTS) => {
    setContextText(SAMPLE_CONTEXTS[key]);
    toast.success('Sample context loaded');
  };

  const isGenerating = generateMutation.isPending || isStreaming;

  return (
    <Main>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mb-6">
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-bold tracking-tight">Pre-Summary Generation</h1>
                <p className="text-muted-foreground mt-1">
                  Generate pre-summaries from clinical context using department-specific templates and your DNA writing style.
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
                      <Select value={visitType} onValueChange={(v) => setVisitType(v as typeof visitType)}>
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

                {/* Input: Context Item ID or Manual Message */}
                <Card data-doc="smr-context-input">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileText className="size-4 text-blue-500" />
                        <CardTitle className="text-sm">Clinical Context</CardTitle>
                      </div>
                      {!debugMode && selectedContextItems.length > 0 && (
                        <Badge variant="secondary" className="text-[10px]">
                          {selectedContextItems.length} selected
                        </Badge>
                      )}
                    </div>
                    {debugMode && <CardDescription className="text-xs">Load context from context item IDs, or enter text manually.</CardDescription>}
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
                          <div className="grid gap-2 sm:grid-cols-5">
                            <div className="sm:col-span-3">
                              <Label htmlFor="context-item-search" className="text-xs">
                                Search Context Items
                              </Label>
                              <div className="relative mt-1">
                                <Search className="text-muted-foreground absolute left-2 top-2.5 size-4" />
                                <Input
                                  id="context-item-search"
                                  placeholder="Search by context item ID (fuzzy match)..."
                                  value={contextSearchQuery}
                                  onChange={(e) => setContextSearchQuery(e.target.value)}
                                  className="pl-8 font-mono text-sm"
                                  onFocus={() => {
                                    setContextSuggestionsOpen(true);
                                    if (!contextSuggestionsLoaded) {
                                      void loadContextSuggestions();
                                    }
                                  }}
                                />
                              </div>
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
                                      {itemType}
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
                                  <div className="mb-2 flex items-center justify-between gap-2">
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
                            <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => loadSample('followup')}>
                              Follow-up Visit
                            </Button>
                            <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => loadSample('newpatient')}>
                              New Patient Referral
                            </Button>
                            <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => loadSample('examination')}>
                              Examination Results
                            </Button>
                          </div>
                          <Textarea
                            rows={12}
                            placeholder="Paste clinical context / consultation transcript here..."
                            value={contextText}
                            onChange={(e) => setContextText(e.target.value)}
                            className="font-mono text-sm resize-y"
                          />
                          <div className="flex justify-between">
                            <p className="text-muted-foreground text-xs">{contextText.length.toLocaleString()} characters</p>
                            {contextText && (
                              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setContextText('')}>
                                Clear
                              </Button>
                            )}
                          </div>
                        </TabsContent>
                      </Tabs>
                    ) : (
                      /* Production mode: context item selection only (no tabs) */
                      <div className="flex flex-col gap-3">
                        <div className="grid gap-2 sm:grid-cols-5">
                          <div className="sm:col-span-3">
                            <Label htmlFor="context-item-search-prod" className="text-xs">
                              Search Context Items
                            </Label>
                            <div className="relative mt-1">
                              <Search className="text-muted-foreground absolute left-2 top-2.5 size-4" />
                              <Input
                                id="context-item-search-prod"
                                placeholder="Search by context item ID (fuzzy match)..."
                                value={contextSearchQuery}
                                onChange={(e) => setContextSearchQuery(e.target.value)}
                                className="pl-8 font-mono text-sm"
                                onFocus={() => {
                                  setContextSuggestionsOpen(true);
                                  if (!contextSuggestionsLoaded) {
                                    void loadContextSuggestions();
                                  }
                                }}
                              />
                            </div>
                          </div>
                          <div className='sm:col-span-1'>
                            <Label className="text-xs">Item Type</Label>
                            <Select value={contextTypeFilter} onValueChange={setContextTypeFilter}>
                              <SelectTrigger className="mt-1 w-full">
                                <SelectValue placeholder="All types" />
                              </SelectTrigger>
                              <SelectContent>
                                {availableContextTypes.map((itemType) => (
                                  <SelectItem key={itemType} value={itemType}>
                                    {itemType}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className='sm:col-span-1'>
                            <Label className="text-xs">Recency</Label>
                            <Select value={contextRecencyFilter} onValueChange={(value) => setContextRecencyFilter(value as ContextRecency)}>
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
                                <div className="mb-2 flex items-center justify-between gap-2">
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

                {/* Streaming output */}
                {isStreaming && (
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Radio className="size-4 text-green-500 animate-pulse" />
                          <CardTitle className="text-sm">SSE Streaming Output</CardTitle>
                        </div>
                        <Badge variant="outline" className="text-[10px] tabular-nums">
                          {streamChunkCount} chunks
                        </Badge>
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
                        title={`Pre-Summary #${results.length - i}`}
                        content={r.content}
                        provider={r.provider}
                        model={r.model}
                        processingTimeMs={r.latency_ms}
                        tokenUsage={r.usage}
                        createdAt={r.created_at}
                        variant="pre-summary"
                        onUseAsContext={(content) => {
                          toast.success('Pre-summary copied — navigate to Summary page to use as context');
                          navigator.clipboard.writeText(content);
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-4 lg:col-span-2">
                {/* Pre-Summary Prompt Template (read-only in debug mode) */}
                <Card data-doc="smr-template-selector">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">Pre-Summary Template / Prompt</CardTitle>
                      {availableTemplates.length > 0 && (
                        <Badge variant="secondary" className="text-[10px]">
                          {availableTemplates.length} template{availableTemplates.length !== 1 ? 's' : ''}
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="text-xs">
                      {debugMode
                        ? 'Select a prompt template by ID — content is read-only in debug mode'
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
                          No pre-summary templates found{userDeptId ? ' for your department' : ''}. Create templates in the Admin section.
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
                        : 'Your personalized writing style — applied automatically to generated pre-summaries'}
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
                                {activeDnaStyle.reportData.sentenceLength && (
                                  <Badge variant="outline" className="text-[10px]">
                                    Sentences: {activeDnaStyle.reportData.sentenceLength}
                                  </Badge>
                                )}
                                {activeDnaStyle.reportData.abbreviationStyle && (
                                  <Badge variant="outline" className="text-[10px]">
                                    Abbrev: {activeDnaStyle.reportData.abbreviationStyle}
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
                            {activeDnaStyle.id && <p className="text-muted-foreground font-mono text-[10px]">ID: {activeDnaStyle.id}</p>}
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        {!activeDnaStyle ? (
                          <div className="flex items-center gap-2 rounded-lg border border-dashed p-3">
                            <AlertCircle className="size-4 text-amber-500" />
                            <div>
                              <p className="text-muted-foreground text-xs">No DNA writing style found for your profile.</p>
                              <p className="text-muted-foreground text-[10px]">
                                Generate one from the DNA Writing Style page to personalize pre-summaries.
                              </p>
                            </div>
                          </div>
                        ) : (
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
                                {activeDnaStyle.reportData.sentenceLength && (
                                  <Badge variant="outline" className="text-[10px]">
                                    Sentences: {activeDnaStyle.reportData.sentenceLength}
                                  </Badge>
                                )}
                                {activeDnaStyle.reportData.abbreviationStyle && (
                                  <Badge variant="outline" className="text-[10px]">
                                    Abbrev: {activeDnaStyle.reportData.abbreviationStyle}
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
                      </>
                    )}
                  </CardContent>
                </Card>

                {/* Provider & Model + Advanced Settings */}
                <Card data-doc="smr-provider-model">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm">Provider & Model</CardTitle>
                    {debugMode && <CardDescription className="text-xs">Debug mode — select any available provider and model</CardDescription>}
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <ProviderModelSelect provider={provider} model={model} onProviderChange={setProvider} onModelChange={setModel} />

                    {debugMode && (
                      <>
                        <Separator />
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
                      </>
                    )}

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
                          <Slider value={[temperature]} onValueChange={([v]) => setTemperature(v)} min={0} max={2} step={0.05} />
                          <p className="text-muted-foreground text-[11px]">Lower = more focused, Higher = more creative</p>
                        </div>

                        <div className="flex flex-col gap-2">
                          <Label htmlFor="pre-max-tokens" className="text-xs">
                            Max Tokens
                          </Label>
                          <Input
                            id="pre-max-tokens"
                            type="number"
                            min={256}
                            max={16384}
                            value={maxTokens}
                            onChange={(e) => setMaxTokens(Number(e.target.value) || 2048)}
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
                    onClick={handleGenerate}
                    disabled={
                      isGenerating ||
                      (debugMode ? (inputMode === 'context_item' ? !hasSelectedContextItems : !hasManualText) : !hasSelectedContextItems)
                    }
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        {isStreaming ? 'Streaming Pre-Summary…' : 'Generating Pre-Summary…'}
                      </>
                    ) : (
                      <>
                        {useStreaming && debugMode ? <Radio className="mr-2 size-4" /> : <Sparkles className="mr-2 size-4" />}
                        {useStreaming && debugMode ? 'Stream Pre-Summary (SSE)' : 'Generate Pre-Summary'}
                      </>
                    )}
                  </Button>
                </div>
                {results.length > 0 && (
                  <Link to="/summarization/summary">
                    <Button variant="outline" className="w-full gap-2">
                      Use in Summary Generation
                      <ArrowRight className="size-4" />
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Main>
  );
}
