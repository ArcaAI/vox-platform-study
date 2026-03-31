import { Button } from '@arcaai/ui/button';
import { Label } from '@arcaai/ui/label';
import { Textarea } from '@arcaai/ui/textarea';
import { Input } from '@arcaai/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { useArca, useStorage } from '@arcaai/vox';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { useState, useRef } from 'react';
import { FileText, Upload, Mic, ClipboardList, Loader2, X, FileAudio, Paperclip, StickyNote, MessageSquareText } from 'lucide-react';

const caseNoteSchema = z.object({
  content: z.string().min(1, 'Content is required'),
});

const summarySchema = z.object({
  content: z.string().min(1, 'Summary content is required'),
});

const worknoteSchema = z.object({ content: z.string().min(1, 'Content is required') });

const transcriptSchema = z.object({
  content: z.string().min(1, 'Transcript content is required'),
});

type CaseNoteValues = z.infer<typeof caseNoteSchema>;
type SummaryValues = z.infer<typeof summarySchema>;
type WorknoteValues = z.infer<typeof worknoteSchema>;
type TranscriptValues = z.infer<typeof transcriptSchema>;

interface CaseNoteFormProps {
  consultationId: string;
  onSuccess?: () => void;
}

export function CaseNoteForm({ consultationId, onSuccess }: CaseNoteFormProps) {
  const { context } = useArca();
  const storage = useStorage();
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
    defaultValues: { content: '' },
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
      await context.addCaseNote(data.content, {
        consultationId,
        type: 'RAW_SUMMARY',
        ...(attachmentUrl && { attachmentUrl }),
      });
      toast.success('Summary context added successfully');
      summaryForm.reset();
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

  const handleAudioUpload = async () => {
    if (!audioFile) {
      toast.error('Please select an audio file first');
      return;
    }
    setIsLoading(true);
    try {
      const key = await uploadAttachment(audioFile);
      if (key) {
        await context.addCaseNote(`Audio recording: ${audioFile.name}`, {
          consultationId,
          type: 'AUDIO_RECORDING',
          attachmentUrl: key,
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
      await context.addContext({ type: 'WORKNOTE', content: data.content, source: 'USER' });
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
        await context.addContext({
          type: 'ATTACHMENT',
          content: `Attachment: ${attachmentFile.name}`,
          source: 'USER',
          metadata: { attachmentKey: key },
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
        <TabsList className="grid w-full shrink-0 grid-cols-6">
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
              {isLoading ? 'Adding...' : 'Add Summary'}
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
