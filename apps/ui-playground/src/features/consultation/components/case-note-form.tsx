import { Button } from '@arcaai/ui/button';
import { Label } from '@arcaai/ui/label';
import { Textarea } from '@arcaai/ui/textarea';
import { Input } from '@arcaai/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { useArca, useStorage, useStoreApi, CONTEXT_ENDPOINTS, type ContextItem, type AddContextInput } from '@arcaai/vox';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { useState, useRef } from 'react';
import {
  FileText,
  Upload,
  Mic,
  ClipboardList,
  Loader2,
  X,
  FileAudio,
  Paperclip,
  StickyNote,
  MessageSquareText,
  LayoutTemplate,
  Boxes,
} from 'lucide-react';

const SUMMARY_TYPE_OPTIONS = [
  { value: 'RAW_SUMMARY', label: 'Summary (standard)' },
  { value: 'MODIFIED_SUMMARY', label: 'Edited Summary' },
  { value: 'PRE_SUMMARY', label: 'Pre-Summary' },
] as const;

type SummaryContextType = (typeof SUMMARY_TYPE_OPTIONS)[number]['value'];

const caseNoteSchema = z.object({
  content: z.string().min(1, 'Content is required'),
});

const summarySchema = z.object({
  summaryType: z.enum(['RAW_SUMMARY', 'MODIFIED_SUMMARY', 'PRE_SUMMARY']),
  content: z.string().min(1, 'Summary content is required'),
});

const worknoteSchema = z.object({ content: z.string().min(1, 'Content is required') });

const transcriptSchema = z.object({
  content: z.string().min(1, 'Transcript content is required'),
});

const templateSchema = z.object({
  name: z.string().min(1, 'Template name is required'),
  content: z.string().min(1, 'Template content is required'),
});

const customSchema = z.object({
  header: z.string().min(1, 'Header is required'),
  content: z.string().min(1, 'Content is required'),
});

type CaseNoteValues = z.infer<typeof caseNoteSchema>;
type SummaryValues = z.infer<typeof summarySchema>;
type WorknoteValues = z.infer<typeof worknoteSchema>;
type TranscriptValues = z.infer<typeof transcriptSchema>;
type TemplateValues = z.infer<typeof templateSchema>;
type CustomValues = z.infer<typeof customSchema>;

interface CaseNoteFormProps {
  consultationId: string;
  onSuccess?: () => void;
}

export function CaseNoteForm({ consultationId, onSuccess }: CaseNoteFormProps) {
  const { context } = useArca();
  const storage = useStorage();
  const storeApi = useStoreApi();

  const addContextItem = async (input: AddContextInput): Promise<ContextItem> => {
    const state = storeApi.getState();
    const apiClient = state.apiClient;
    const consultation = state.consultation;
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultation) throw new Error('No active consultation');
    // TASK-331 doc-06 F7 — post against the consultationId *prop* (the rendered
    // consultation), not the store's active session id, which can diverge when
    // the rendered consultation isn't the last-loaded one (e.g. workspace dialog).
    const item = await apiClient.post<ContextItem>(CONTEXT_ENDPOINTS.ADD(consultationId), {
      source: 'USER',
      ...input,
    });
    state.addContextItem(item);
    return item;
  };

  const [isLoading, setIsLoading] = useState(false);
  const [caseNoteFile, setCaseNoteFile] = useState<File | null>(null);
  const [summaryFile, setSummaryFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const caseNoteFileRef = useRef<HTMLInputElement>(null);
  const summaryFileRef = useRef<HTMLInputElement>(null);
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const attachmentFileRef = useRef<HTMLInputElement>(null);

  const caseNoteForm = useForm<CaseNoteValues>({
    resolver: zodResolver(caseNoteSchema),
    defaultValues: { content: '' },
  });

  const summaryForm = useForm<SummaryValues>({
    resolver: zodResolver(summarySchema),
    defaultValues: { summaryType: 'RAW_SUMMARY', content: '' },
  });

  const selectedSummaryType = summaryForm.watch('summaryType') as SummaryContextType;

  const templateForm = useForm<TemplateValues>({
    resolver: zodResolver(templateSchema),
    defaultValues: { name: '', content: '' },
  });

  const customForm = useForm<CustomValues>({
    resolver: zodResolver(customSchema),
    defaultValues: { header: '', content: '' },
  });

  const worknoteForm = useForm<WorknoteValues>({
    resolver: zodResolver(worknoteSchema),
    defaultValues: { content: '' },
  });

  const transcriptForm = useForm<TranscriptValues>({
    resolver: zodResolver(transcriptSchema),
    defaultValues: { content: '' },
  });

  const uploadAttachment = async (file: File): Promise<string | undefined> => {
    try {
      const uploaded = await storage.uploadFile('attachments', file);
      return uploaded?.key;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      toast.error(`File upload failed: ${message}`);
      return undefined;
    }
  };

  const handleCaseNote = async (data: CaseNoteValues) => {
    setIsLoading(true);
    try {
      let attachmentUrl: string | undefined;
      if (caseNoteFile) {
        attachmentUrl = await uploadAttachment(caseNoteFile);
      }
      await context.addCaseNote(data.content, {
        consultationId,
        ...(attachmentUrl && { attachmentUrl }),
      });
      toast.success('Case note added successfully');
      caseNoteForm.reset();
      setCaseNoteFile(null);
      if (caseNoteFileRef.current) caseNoteFileRef.current.value = '';
      onSuccess?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add case note';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSummary = async (data: SummaryValues) => {
    setIsLoading(true);
    try {
      let attachmentUrl: string | undefined;
      if (summaryFile) {
        attachmentUrl = await uploadAttachment(summaryFile);
      }
      await addContextItem({
        type: data.summaryType,
        content: data.content,
        source: 'USER',
        ...(attachmentUrl && { structuredData: { attachmentUrl } }),
      });
      const typeLabel = SUMMARY_TYPE_OPTIONS.find((o) => o.value === data.summaryType)?.label ?? 'Summary';
      toast.success(`${typeLabel} added successfully`);
      summaryForm.reset({ summaryType: data.summaryType, content: '' });
      setSummaryFile(null);
      if (summaryFileRef.current) summaryFileRef.current.value = '';
      onSuccess?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add summary';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTemplate = async (data: TemplateValues) => {
    setIsLoading(true);
    try {
      await addContextItem({
        type: 'WORKNOTE',
        content: data.content,
        source: 'USER',
        structuredData: { kind: 'TEMPLATE', name: data.name },
      });
      toast.success('Template added successfully');
      templateForm.reset();
      onSuccess?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add template';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCustom = async (data: CustomValues) => {
    setIsLoading(true);
    try {
      await addContextItem({
        type: 'WORKNOTE',
        content: `${data.header}\n\n${data.content}`,
        source: 'USER',
        structuredData: { kind: 'CUSTOM', header: data.header },
      });
      toast.success(`Custom item "${data.header}" added successfully`);
      customForm.reset();
      onSuccess?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add custom item';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAudioUpload = async () => {
    if (!audioFile) {
      toast.error('Please select an audio file first');
      return;
    }
    setIsLoading(true);
    try {
      const key = await uploadAttachment(audioFile);
      if (key) {
        await addContextItem({
          type: 'AUDIO_RECORDING',
          content: `Audio recording: ${audioFile.name}`,
          source: 'USER',
          structuredData: { attachmentKey: key },
        });
        toast.success('Audio file uploaded successfully');
        setAudioFile(null);
        if (audioInputRef.current) audioInputRef.current.value = '';
        onSuccess?.();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload audio';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleWorknote = async (data: WorknoteValues) => {
    setIsLoading(true);
    try {
      await addContextItem({ type: 'WORKNOTE', content: data.content, source: 'USER' });
      toast.success('Work note added successfully');
      worknoteForm.reset();
      onSuccess?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add work note';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleTranscript = async (data: TranscriptValues) => {
    setIsLoading(true);
    try {
      await context.addTranscription(data.content);
      toast.success('Transcript added successfully');
      transcriptForm.reset();
      onSuccess?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to add transcript';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAttachmentUpload = async () => {
    if (!attachmentFile) {
      toast.error('Please select a file first');
      return;
    }
    setIsLoading(true);
    try {
      const key = await uploadAttachment(attachmentFile);
      if (key) {
        await addContextItem({
          type: 'ATTACHMENT',
          content: `Attachment: ${attachmentFile.name}`,
          source: 'USER',
          structuredData: { attachmentKey: key },
        });
        toast.success('Attachment uploaded successfully');
        setAttachmentFile(null);
        if (attachmentFileRef.current) attachmentFileRef.current.value = '';
        onSuccess?.();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to upload attachment';
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Tabs defaultValue="case-note" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="grid w-full shrink-0 grid-cols-4 gap-1 lg:grid-cols-8">
          <TabsTrigger value="case-note" className="gap-1.5">
            <FileText className="size-3.5" />
            Case Note
          </TabsTrigger>
          <TabsTrigger value="transcript" className="gap-1.5">
            <MessageSquareText className="size-3.5" />
            Transcript
          </TabsTrigger>
          <TabsTrigger value="summary" className="gap-1.5">
            <ClipboardList className="size-3.5" />
            Summary
          </TabsTrigger>
          <TabsTrigger value="template" className="gap-1.5">
            <LayoutTemplate className="size-3.5" />
            Template
          </TabsTrigger>
          <TabsTrigger value="custom" className="gap-1.5">
            <Boxes className="size-3.5" />
            Custom
          </TabsTrigger>
          <TabsTrigger value="worknote" className="gap-1.5">
            <StickyNote className="size-3.5" />
            Work Note
          </TabsTrigger>
          <TabsTrigger value="audio" className="gap-1.5">
            <Mic className="size-3.5" />
            Audio File
          </TabsTrigger>
          <TabsTrigger value="attachment" className="gap-1.5">
            <Paperclip className="size-3.5" />
            Attachment
          </TabsTrigger>
        </TabsList>

        <TabsContent value="case-note" className="mt-4 flex min-h-0 flex-1 flex-col">
          <form onSubmit={caseNoteForm.handleSubmit(handleCaseNote)} className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <Label htmlFor="cn-content">
                Content <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="cn-content"
                className="min-h-0 flex-1 resize-none"
                placeholder="Enter clinical observations, patient history, or other case notes..."
                aria-invalid={!!caseNoteForm.formState.errors.content}
                {...caseNoteForm.register('content')}
              />
              {caseNoteForm.formState.errors.content && (
                <p className="text-destructive text-sm" role="alert">
                  {caseNoteForm.formState.errors.content.message}
                </p>
              )}
            </div>
            <div className="shrink-0 space-y-2">
              <Label htmlFor="cn-attachment">
                <Paperclip className="mr-1 inline size-3.5" />
                Attachment (optional)
              </Label>
              <Input ref={caseNoteFileRef} id="cn-attachment" type="file" onChange={(e) => setCaseNoteFile(e.target.files?.[0] ?? null)} />
              {caseNoteFile && (
                <div className="flex items-center gap-2 rounded-md border p-2 text-sm">
                  <Paperclip className="text-muted-foreground size-3.5" />
                  <span className="flex-1 truncate">{caseNoteFile.name}</span>
                  <span className="text-muted-foreground text-xs">{(caseNoteFile.size / 1024).toFixed(0)} KB</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-6 p-0"
                    onClick={() => {
                      setCaseNoteFile(null);
                      if (caseNoteFileRef.current) caseNoteFileRef.current.value = '';
                    }}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              )}
            </div>
            <Button type="submit" className="shrink-0 self-start" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isLoading ? 'Adding...' : 'Add Case Note'}
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="transcript" className="mt-4 flex min-h-0 flex-1 flex-col">
          <form onSubmit={transcriptForm.handleSubmit(handleTranscript)} className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <Label htmlFor="tr-content">
                Transcript Content <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="tr-content"
                className="min-h-0 flex-1 resize-none"
                placeholder="Paste or enter a transcription of the consultation audio..."
                aria-invalid={!!transcriptForm.formState.errors.content}
                {...transcriptForm.register('content')}
              />
              {transcriptForm.formState.errors.content && (
                <p className="text-destructive text-sm" role="alert">
                  {transcriptForm.formState.errors.content.message}
                </p>
              )}
            </div>
            <Button type="submit" className="shrink-0 self-start" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isLoading ? 'Adding...' : 'Add Transcript'}
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="summary" className="mt-4 flex min-h-0 flex-1 flex-col">
          <form onSubmit={summaryForm.handleSubmit(handleSummary)} className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="shrink-0 space-y-2">
              <Label htmlFor="sum-type">
                Summary Type <span className="text-destructive">*</span>
              </Label>
              <Select
                value={selectedSummaryType}
                onValueChange={(value: string) => summaryForm.setValue('summaryType', value as SummaryContextType, { shouldDirty: true })}
              >
                <SelectTrigger id="sum-type" className="w-full">
                  <SelectValue placeholder="Select summary type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SUMMARY_TYPE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <Label htmlFor="sum-content">
                Summary Content <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="sum-content"
                className="min-h-0 flex-1 resize-none"
                placeholder="Enter a raw summary or pre-existing clinical summary..."
                aria-invalid={!!summaryForm.formState.errors.content}
                {...summaryForm.register('content')}
              />
              {summaryForm.formState.errors.content && (
                <p className="text-destructive text-sm" role="alert">
                  {summaryForm.formState.errors.content.message}
                </p>
              )}
            </div>
            <div className="shrink-0 space-y-2">
              <Label htmlFor="sum-attachment">
                <Paperclip className="mr-1 inline size-3.5" />
                Attachment (optional)
              </Label>
              <Input ref={summaryFileRef} id="sum-attachment" type="file" onChange={(e) => setSummaryFile(e.target.files?.[0] ?? null)} />
              {summaryFile && (
                <div className="flex items-center gap-2 rounded-md border p-2 text-sm">
                  <Paperclip className="text-muted-foreground size-3.5" />
                  <span className="flex-1 truncate">{summaryFile.name}</span>
                  <span className="text-muted-foreground text-xs">{(summaryFile.size / 1024).toFixed(0)} KB</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="size-6 p-0"
                    onClick={() => {
                      setSummaryFile(null);
                      if (summaryFileRef.current) summaryFileRef.current.value = '';
                    }}
                  >
                    <X className="size-3" />
                  </Button>
                </div>
              )}
            </div>
            <Button type="submit" className="shrink-0 self-start" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isLoading ? 'Adding...' : `Add ${SUMMARY_TYPE_OPTIONS.find((o) => o.value === selectedSummaryType)?.label ?? 'Summary'}`}
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="template" className="mt-4 flex min-h-0 flex-1 flex-col">
          <form onSubmit={templateForm.handleSubmit(handleTemplate)} className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="shrink-0 space-y-2">
              <Label htmlFor="tpl-name">
                Template Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="tpl-name"
                placeholder="e.g. Cardiology Consultation Template"
                aria-invalid={!!templateForm.formState.errors.name}
                {...templateForm.register('name')}
              />
              {templateForm.formState.errors.name && (
                <p className="text-destructive text-sm" role="alert">
                  {templateForm.formState.errors.name.message}
                </p>
              )}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <Label htmlFor="tpl-content">
                Template Content <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="tpl-content"
                className="min-h-0 flex-1 resize-none"
                placeholder="Paste the template used to steer the AI output..."
                aria-invalid={!!templateForm.formState.errors.content}
                {...templateForm.register('content')}
              />
              {templateForm.formState.errors.content && (
                <p className="text-destructive text-sm" role="alert">
                  {templateForm.formState.errors.content.message}
                </p>
              )}
            </div>
            <Button type="submit" className="shrink-0 self-start" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isLoading ? 'Adding...' : 'Add Template'}
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="custom" className="mt-4 flex min-h-0 flex-1 flex-col">
          <form onSubmit={customForm.handleSubmit(handleCustom)} className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="shrink-0 space-y-2">
              <Label htmlFor="cus-header">
                Header <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cus-header"
                placeholder='e.g. "Lab Results"'
                aria-invalid={!!customForm.formState.errors.header}
                {...customForm.register('header')}
              />
              {customForm.formState.errors.header && (
                <p className="text-destructive text-sm" role="alert">
                  {customForm.formState.errors.header.message}
                </p>
              )}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <Label htmlFor="cus-content">
                Content <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="cus-content"
                className="min-h-0 flex-1 resize-none"
                placeholder='e.g. "Hemoglobin 12.5, WBC 7.2, Platelets 245..."'
                aria-invalid={!!customForm.formState.errors.content}
                {...customForm.register('content')}
              />
              {customForm.formState.errors.content && (
                <p className="text-destructive text-sm" role="alert">
                  {customForm.formState.errors.content.message}
                </p>
              )}
            </div>
            <Button type="submit" className="shrink-0 self-start" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isLoading ? 'Adding...' : 'Add Custom Item'}
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="worknote" className="mt-4 flex min-h-0 flex-1 flex-col">
          <form onSubmit={worknoteForm.handleSubmit(handleWorknote)} className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <Label htmlFor="wn-content">
                Content <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="wn-content"
                className="min-h-0 flex-1 resize-none"
                placeholder="Enter work notes, internal observations, or task-related details..."
                aria-invalid={!!worknoteForm.formState.errors.content}
                {...worknoteForm.register('content')}
              />
              {worknoteForm.formState.errors.content && (
                <p className="text-destructive text-sm" role="alert">
                  {worknoteForm.formState.errors.content.message}
                </p>
              )}
            </div>
            <Button type="submit" className="shrink-0 self-start" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isLoading ? 'Adding...' : 'Add Work Note'}
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="audio" className="mt-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="audio-file">Audio File</Label>
              <Input ref={audioInputRef} id="audio-file" type="file" accept="audio/*" onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)} />
              <p className="text-muted-foreground text-xs">Supported formats: WAV, MP3, WebM, OGG, FLAC (max 100 MB)</p>
            </div>
            {audioFile && (
              <div className="flex items-center gap-3 rounded-lg border p-3">
                <FileAudio className="text-muted-foreground size-5" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{audioFile.name}</p>
                  <p className="text-muted-foreground text-xs">{(audioFile.size / 1024 / 1024).toFixed(1)} MB</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAudioFile(null);
                    if (audioInputRef.current) audioInputRef.current.value = '';
                  }}
                >
                  <X className="size-4" />
                </Button>
              </div>
            )}
            <Button onClick={handleAudioUpload} disabled={isLoading || !audioFile}>
              {isLoading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Upload className="mr-1.5 size-4" />}
              {isLoading ? 'Uploading...' : 'Upload Audio'}
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="attachment" className="mt-4">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="attachment-file">File</Label>
              <Input ref={attachmentFileRef} id="attachment-file" type="file" onChange={(e) => setAttachmentFile(e.target.files?.[0] ?? null)} />
            </div>
            {attachmentFile && (
              <div className="flex items-center gap-3 rounded-lg border p-3">
                <Paperclip className="text-muted-foreground size-5" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{attachmentFile.name}</p>
                  <p className="text-muted-foreground text-xs">{(attachmentFile.size / 1024 / 1024).toFixed(1)} MB</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAttachmentFile(null);
                    if (attachmentFileRef.current) attachmentFileRef.current.value = '';
                  }}
                >
                  <X className="size-4" />
                </Button>
              </div>
            )}
            <Button onClick={handleAttachmentUpload} disabled={isLoading || !attachmentFile}>
              {isLoading ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Upload className="mr-1.5 size-4" />}
              {isLoading ? 'Uploading...' : 'Upload Attachment'}
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
