import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useDnaStyle, type DnaReport, type DnaStyleVersion, type UseDnaStyleReturn } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Fingerprint, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { GenerateDnaDialog } from '@/features/playground/generate-dna-dialog';
import { dnaAttributeEntries } from '@/features/playground/playground-format';
import { formatDateTime } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/playground/dna-style')({
  component: DnaStylePage,
});

const ADMIN_PAGE_SIZE = 20;

/**
 * The SDK doesn't barrel-export `AdminDnaReportPage` (only the hook return
 * type), so derive it — same no-SDK-edit pattern TASK-391 used for the audit
 * export format union.
 */
type AdminDnaReportPage = Awaited<ReturnType<UseDnaStyleReturn['adminListReports']>>;

/**
 * TASK-408 — screen 53 · DNA Writing Style (playground tier). Two views over
 * the real DNA endpoints: **My style** (the signed-in identity's latest report
 * + versions + generate-from-samples with job polling) and **All reports**
 * (the admin cross-user list — tenant-scoped even for SUPER_ADMIN, flagged).
 */
function DnaStylePage() {
  const dna = useDnaStyle();

  const [myStyle, setMyStyle] = useState<DnaReport | null>(null);
  const [myStyleChecked, setMyStyleChecked] = useState(false);
  const [versions, setVersions] = useState<DnaStyleVersion[]>([]);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generating, setGenerating] = useState(false);

  const [adminPage, setAdminPage] = useState<AdminDnaReportPage | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [pageNum, setPageNum] = useState(1);

  const loadMyStyle = async () => {
    try {
      const report = await dna.getMyStyle();
      setMyStyle(report);
      const v = await dna.getVersions(report.id).catch(() => []);
      setVersions(v);
    } catch {
      // 404 = no report generated yet — an expected empty state, not an error.
      setMyStyle(null);
      setVersions([]);
    } finally {
      setMyStyleChecked(true);
    }
  };

  const loadAdminReports = async (page: number) => {
    setAdminError(null);
    try {
      const result = await dna.adminListReports({ page, limit: ADMIN_PAGE_SIZE });
      setAdminPage(result);
    } catch (err) {
      setAdminPage(null);
      setAdminError(err instanceof Error ? err.message : 'Could not load reports.');
    }
  };

  useEffect(() => {
    void loadMyStyle();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, []);

  useEffect(() => {
    void loadAdminReports(pageNum);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum]);

  const onGenerate = async (textSamples: string[]) => {
    try {
      const { jobId } = await dna.generate({ textSamples });
      toast.success('Generation queued — analyzing your writing samples.');
      setGenerating(true);
      void dna
        .pollJobStatus(jobId)
        .then((report) => {
          setMyStyle(report);
          toast.success('DNA writing style generated.');
          void dna
            .getVersions(report.id)
            .then(setVersions)
            .catch(() => undefined);
          void loadAdminReports(pageNum);
        })
        .catch((err: unknown) => {
          toast.error(err instanceof Error ? err.message : 'DNA generation failed.');
        })
        .finally(() => setGenerating(false));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not queue the generation.');
      throw err;
    }
  };

  const attributes = dnaAttributeEntries(myStyle?.reportData);
  const totalPages = adminPage ? Math.max(1, Math.ceil(adminPage.count / adminPage.limit)) : 1;

  return (
    <div>
      <PageHeader
        title="DNA Writing Style"
        description="Personalized writing-style profiles the summarization pipeline uses to match each clinician's voice. Generate your own from writing samples; browse the workspace's reports."
        actions={
          <Button size="sm" onClick={() => setGenerateOpen(true)} disabled={generating}>
            <Sparkles className="size-4" />
            {generating ? 'Generating…' : 'Generate from samples'}
          </Button>
        }
      />

      {generating ? (
        <Card className="mb-4 p-4" data-testid="dna-job-strip">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge label="Generating" colorRole="info" />
            <span className="text-muted-foreground">Background analysis job running — this view refreshes automatically when it completes.</span>
          </div>
        </Card>
      ) : null}

      <Tabs defaultValue="mine">
        <TabsList>
          <TabsTrigger value="mine">My style</TabsTrigger>
          <TabsTrigger value="all">All reports</TabsTrigger>
        </TabsList>

        <TabsContent value="mine" className="mt-4">
          {!myStyleChecked ? (
            <Card className="space-y-3 p-4">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <div className="flex gap-2">
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-28 rounded-full" />
              </div>
            </Card>
          ) : !myStyle ? (
            <Card className="flex flex-col items-center gap-2 p-10 text-center" data-testid="dna-empty-state">
              <Fingerprint className="size-9 text-muted-foreground" />
              <p className="font-medium">No DNA style for this account yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Generate one from a few writing samples — the analysis service extracts tone, formality and structure so generated summaries read like
                you wrote them.
              </p>
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,320px)]">
              <Card className="p-4" data-testid="dna-style-card">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold">Current style</h3>
                  {myStyle.isLatest ? <StatusBadge label="Latest" colorRole="success" /> : null}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    v{myStyle.currentVersionNumber} · updated {formatDateTime(myStyle.updatedAt)}
                  </span>
                </div>
                {attributes.length > 0 ? (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {attributes.map((a) => (
                      <Badge key={a.label} variant="secondary" className="font-normal">
                        {a.label}: {a.value}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {myStyle.styleText ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{myStyle.styleText}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">This report carries structured attributes only (no style text).</p>
                )}
              </Card>

              <Card className="p-4">
                <h3 className="mb-3 text-sm font-semibold">
                  Versions <span className="tabular-nums text-muted-foreground">({versions.length})</span>
                </h3>
                {versions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No version history yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {versions.map((v) => (
                      <li key={v.id} className="rounded-md border p-2.5 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs">v{v.versionNumber}</span>
                          <span className="text-xs tabular-nums text-muted-foreground">{formatDateTime(v.createdAt)}</span>
                        </div>
                        {v.changeReason ? <p className="mt-1 text-xs text-muted-foreground">{v.changeReason}</p> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          )}
        </TabsContent>

        <TabsContent value="all" className="mt-4">
          {adminError ? (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertTitle>Couldn’t load workspace reports</AlertTitle>
              <AlertDescription>{adminError} — the cross-user list requires an admin role.</AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Doctor</TableHead>
                      <TableHead className="text-right">Version</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="max-md:hidden">Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {!adminPage ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={4}>
                            <Skeleton className="h-6 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : adminPage.data.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="h-28 text-center">
                          <div className="flex flex-col items-center gap-2">
                            <Fingerprint className="size-8 text-muted-foreground" />
                            <p className="text-sm font-medium">No DNA reports in this workspace</p>
                            <p className="text-xs text-muted-foreground">Reports appear once clinicians (or you) generate a style.</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      adminPage.data.map((r) => (
                        <TableRow key={r.id} data-testid={`dna-report-row-${r.id}`}>
                          <TableCell>
                            <span className="font-mono text-xs">{r.doctorId}</span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">v{r.currentVersionNumber}</TableCell>
                          <TableCell>
                            {r.isLatest ? <StatusBadge label="Latest" colorRole="success" /> : <StatusBadge label="Historical" colorRole="neutral" />}
                          </TableCell>
                          <TableCell className="tabular-nums max-md:hidden">{formatDateTime(r.updatedAt)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Tenant-scoped — even super-admins see only the active workspace’s reports (cross-tenant browse is a flagged backlog item).
                </p>
                {adminPage && adminPage.count > adminPage.limit ? (
                  <div className="flex items-center gap-2 text-xs">
                    <Button variant="outline" size="sm" className="h-7" disabled={pageNum <= 1} onClick={() => setPageNum((p) => p - 1)}>
                      Previous
                    </Button>
                    <span className="tabular-nums text-muted-foreground">
                      Page {pageNum} of {totalPages}
                    </span>
                    <Button variant="outline" size="sm" className="h-7" disabled={pageNum >= totalPages} onClick={() => setPageNum((p) => p + 1)}>
                      Next
                    </Button>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>

      <GenerateDnaDialog open={generateOpen} onOpenChange={setGenerateOpen} onGenerate={onGenerate} />
    </div>
  );
}
