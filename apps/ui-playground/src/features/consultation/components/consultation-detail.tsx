import { Main } from '@/components/layout/main';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent } from '@arcaai/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Separator } from '@arcaai/ui/separator';
import { useArca } from '@arcaai/vox';
import type { Consultation } from '@arcaai/vox';
import { useParams, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, useCallback, useRef } from 'react';
import { ArrowLeft, ClipboardList, FileText, Sparkles, Calendar, User, Building2, RefreshCw, AlertCircle } from 'lucide-react';
import { ContextItemList } from './context-item-list';
import { CaseNoteForm } from './case-note-form';
import { SummaryPanel } from './summary-panel';
import { toast } from 'sonner';

const statusVariant: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  OPEN: 'default',
  RECORDING: 'default',
  TRANSCRIBING: 'secondary',
  SUMMARIZING: 'secondary',
  REVIEW: 'outline',
  CLOSED: 'secondary',
  CANCELLED: 'destructive',
};

interface DoctorInfo {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
}

interface DepartmentInfo {
  id: string;
  code?: string;
  name?: string;
}

function getDoctorDisplayName(c: Consultation): string | undefined {
  if (c.doctorName) return c.doctorName;
  const doc = (c as unknown as Record<string, unknown>).doctor as DoctorInfo | undefined;
  if (!doc) return undefined;
  const parts = [doc.firstName, doc.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : doc.username;
}

function getDepartmentDisplayName(c: Consultation): string | undefined {
  if (typeof c.department === 'string') return c.department;
  const dept = (c as unknown as Record<string, unknown>).department as DepartmentInfo | undefined;
  if (!dept) return undefined;
  return dept.name || dept.code || undefined;
}

function getConsultationStatus(c: Consultation): string | undefined {
  if (c.status) return c.status;
  const meta = c.metadata as Record<string, unknown> | undefined;
  return (meta?.status as string) ?? undefined;
}

export default function ConsultationDetail() {
  const { id } = useParams({ from: '/_authenticated/consultation/$id' });
  const navigate = useNavigate();
  const { session } = useArca();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [consultation, setConsultation] = useState<Consultation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('context');

  const loadConsultation = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await sessionRef.current.load(id);
      setConsultation(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load consultation';
      setError(message);
      setConsultation(null);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadConsultation();
  }, [loadConsultation]);

  if (isLoading) {
    return (
      <Main>
        <div className="space-y-6">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-28" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-10 w-96" />
          <Skeleton className="h-64 w-full" />
        </div>
      </Main>
    );
  }

  if (error) {
    return (
      <Main>
        <div className="space-y-4">
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/consultation' })}>
            <ArrowLeft className="mr-1 size-4" />
            Back to list
          </Button>
          <Card className="border-destructive/50">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <AlertCircle className="text-destructive mb-4 size-12" />
              <h3 className="mb-1 text-lg font-medium">Failed to Load Consultation</h3>
              <p className="text-muted-foreground mb-4 max-w-md text-center text-sm">{error}</p>
              <Button onClick={loadConsultation} variant="outline">
                <RefreshCw className="mr-1.5 size-4" />
                Retry
              </Button>
            </CardContent>
          </Card>
        </div>
      </Main>
    );
  }

  return (
    <Main>
      <div className="mb-6 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/consultation' })}>
          <ArrowLeft className="mr-1 size-4" />
          Back to list
        </Button>

        {consultation &&
          (() => {
            const doctorDisplay = getDoctorDisplayName(consultation);
            const deptDisplay = getDepartmentDisplayName(consultation);
            const status = getConsultationStatus(consultation);

            return (
              <>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-3">
                      <h1 className="text-2xl font-bold tracking-tight">Patient: {consultation.patientId || 'Unknown'}</h1>
                      {status && <Badge variant={statusVariant[status] ?? 'outline'}>{status}</Badge>}
                      {consultation.isNew && (
                        <Badge variant="secondary" className="text-xs">
                          NEW
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 font-mono text-xs">ID: {id}</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={loadConsultation}>
                    <RefreshCw className="mr-1.5 size-4" />
                    Refresh
                  </Button>
                </div>

                <div className="flex flex-wrap gap-4 text-sm">
                  {consultation.appointmentDate && (
                    <div className="text-muted-foreground flex items-center gap-1.5">
                      <Calendar className="size-3.5" />
                      <span>
                        {new Date(consultation.appointmentDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
                      </span>
                    </div>
                  )}
                  {(doctorDisplay || consultation.doctorId) && (
                    <div className="text-muted-foreground flex items-center gap-1.5">
                      <User className="size-3.5" />
                      <span>{doctorDisplay ? `Dr. ${doctorDisplay}` : consultation.doctorId}</span>
                    </div>
                  )}
                  {deptDisplay && (
                    <div className="text-muted-foreground flex items-center gap-1.5">
                      <Building2 className="size-3.5" />
                      <span>{deptDisplay}</span>
                    </div>
                  )}
                </div>
              </>
            );
          })()}

        <Separator />
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 lg:w-auto lg:grid-cols-none lg:flex">
          <TabsTrigger value="context" className="gap-1.5">
            <ClipboardList className="size-4" />
            Context Items
          </TabsTrigger>
          <TabsTrigger value="add" className="gap-1.5">
            <FileText className="size-4" />
            Add Context
          </TabsTrigger>
          <TabsTrigger value="summary" className="gap-1.5">
            <Sparkles className="size-4" />
            Summaries
          </TabsTrigger>
        </TabsList>

        <TabsContent value="context">
          <ContextItemList consultationId={id} />
        </TabsContent>

        <TabsContent value="add">
          <CaseNoteForm
            consultationId={id}
            onSuccess={() => {
              loadConsultation();
              setActiveTab('context');
              toast.success('Context added — switching to Context Items tab');
            }}
          />
        </TabsContent>

        <TabsContent value="summary">
          <SummaryPanel consultationId={id} />
        </TabsContent>
      </Tabs>
    </Main>
  );
}
