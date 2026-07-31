import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Textarea,
} from '@arcaai/ui';
import {
  useSMR,
  type EnhancedMedicalSummary,
  type MedicalSummary,
  type SimplifiedMedicalSummary,
  type SoapMedicalSummary,
  type SummaryResponse,
} from '@arcaai/vox/compat';
import { toast } from 'sonner';
import { fetchDepartments, type DepartmentOption } from '../lib/departments';
import { saveStoredConfig, type PlaygroundConfig } from '../lib/config-store';

interface SummaryCardProps {
  config: PlaygroundConfig;
  /** Live transcript lines accumulated in the workspace (text only). */
  transcriptLines: string[];
}

/** The preset visit types. The gateway normalizes these server-side. */
const VISIT_TYPE_PRESETS = ['New Patient', 'Revisit', 'Referral'] as const;
/** Sentinel value for the "custom / free text" option in the visit-type select. */
const CUSTOM_VISIT = '__custom__';
/** Sentinel value for the "custom / free text" option in the department select. */
const CUSTOM_DEPT = '__custom__';

type DeptFetchState = 'loading' | 'list' | 'freetext';

// =============================================================================
// Summary renderers — discriminate Enhanced / Simplified / SOAP by shape
// =============================================================================

function isEnhanced(s: MedicalSummary): s is EnhancedMedicalSummary {
  return (s as Partial<EnhancedMedicalSummary>).encounter_summary !== undefined;
}
function isSoap(s: MedicalSummary): s is SoapMedicalSummary {
  return (s as Partial<SoapMedicalSummary>).subjective !== undefined;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-semibold">{title}</h4>
      <div className="text-muted-foreground text-sm">{children}</div>
    </div>
  );
}

function EnhancedView({ s }: { s: EnhancedMedicalSummary }) {
  const meds = s.treatment_plan.medications ?? [];
  return (
    <div className="flex flex-col gap-3">
      <Section title="Chief complaint">{s.encounter_summary.chief_complaint || '—'}</Section>
      <Section title="Primary diagnosis">
        {s.clinical_assessment.primary_diagnosis.diagnosis || '—'}
        {s.clinical_assessment.primary_diagnosis.icd10_code ? (
          <Badge variant="outline" className="ml-2">
            {s.clinical_assessment.primary_diagnosis.icd10_code}
          </Badge>
        ) : null}
      </Section>
      {meds.length > 0 ? (
        <Section title="Medications">
          <ul className="list-inside list-disc">
            {meds.map((m, i) => (
              <li key={i}>
                {m.name}
                {m.dose ? ` — ${m.dose}` : ''}
                {m.frequency ? ` (${m.frequency})` : ''}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Clinical summary">{s.clinical_summary.summary || '—'}</Section>
    </div>
  );
}

function SimplifiedView({ s }: { s: SimplifiedMedicalSummary }) {
  return (
    <div className="flex flex-col gap-3">
      <Section title="Chief complaint">{s.chief_complaint || '—'}</Section>
      {s.symptoms?.length ? (
        <Section title="Symptoms">
          <ul className="list-inside list-disc">
            {s.symptoms.map((sym, i) => (
              <li key={i}>{sym}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Assessment">{s.assessment || '—'}</Section>
      <Section title="Treatment plan">{s.treatment_plan || '—'}</Section>
      <Section title="Summary">{s.summary || '—'}</Section>
    </div>
  );
}

function SoapView({ s }: { s: SoapMedicalSummary }) {
  return (
    <div className="flex flex-col gap-3">
      <Section title="Subjective">{s.subjective || '—'}</Section>
      <Section title="Objective">{s.objective || '—'}</Section>
      <Section title="Assessment">{s.assessment || '—'}</Section>
      <Section title="Plan">{s.plan || '—'}</Section>
    </div>
  );
}

function SummaryView({ summary }: { summary: SummaryResponse }) {
  const s = summary.summary;
  if (isEnhanced(s)) return <EnhancedView s={s} />;
  if (isSoap(s)) return <SoapView s={s} />;
  return <SimplifiedView s={s as SimplifiedMedicalSummary} />;
}

// =============================================================================
// SummaryCard
// =============================================================================

/**
 * Workstream B (TASK-592) — the pre-summarization → summarization surface,
 * wired to the v1-compat SMR API through `useSMR()`. Pick a REAL tenant
 * department (so the Workstream-A gateway resolver can match it to a governed
 * instruction template), add clinical context, pre-summarize, then summarize
 * the transcript with the pre-summary folded into context.
 */
export function SummaryCard({ config, transcriptLines }: SummaryCardProps) {
  const { preSummarize, summarizeSync, loading } = useSMR();

  // Department picker: fetch on mount / when credentials change.
  const [deptState, setDeptState] = useState<DeptFetchState>('loading');
  const [deptOptions, setDeptOptions] = useState<DepartmentOption[]>([]);
  const [department, setDepartment] = useState(config.department ?? '');
  const [deptIsCustom, setDeptIsCustom] = useState(false);

  // Visit type.
  const seededVisit = config.visitType ?? 'New Patient';
  const seededIsPreset = (VISIT_TYPE_PRESETS as readonly string[]).includes(seededVisit);
  const [visitType, setVisitType] = useState(seededIsPreset ? seededVisit : 'New Patient');
  const [visitIsCustom, setVisitIsCustom] = useState(!seededIsPreset && seededVisit !== '');
  const [customVisit, setCustomVisit] = useState(seededIsPreset ? '' : seededVisit);

  // Clinical context.
  const [age, setAge] = useState('');
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState('');
  const [vitals, setVitals] = useState('');
  const [testResults, setTestResults] = useState('');
  const [previousVisits, setPreviousVisits] = useState('');

  // Transcript source: paste-in overrides the live lines when non-empty.
  const [pasteTranscript, setPasteTranscript] = useState('');
  const [useEnhanced, setUseEnhanced] = useState(true);

  // Results.
  const [preSummary, setPreSummary] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);

  const apiEndpoint = config.apiEndpoint;
  const apiKey = config.apiKey;

  useEffect(() => {
    let cancelled = false;
    setDeptState('loading');
    fetchDepartments(apiEndpoint, apiKey)
      .then((options) => {
        if (cancelled) return;
        if (options.length === 0) {
          setDeptState('freetext');
          return;
        }
        setDeptOptions(options);
        setDeptState('list');
      })
      .catch(() => {
        if (!cancelled) setDeptState('freetext');
      });
    return () => {
      cancelled = true;
    };
  }, [apiEndpoint, apiKey]);

  const effectiveTranscript = useMemo(
    () => (pasteTranscript.trim() ? pasteTranscript : transcriptLines.join('\n')),
    [pasteTranscript, transcriptLines],
  );
  const hasTranscript = effectiveTranscript.trim().length > 0;
  const effectiveVisit = visitIsCustom ? customVisit.trim() : visitType;

  const persistDefaults = () => {
    saveStoredConfig({ ...config, department: department.trim(), visitType: effectiveVisit });
  };

  const handlePreSummarize = async () => {
    try {
      const res = await preSummarize({
        current_department: department.trim() || undefined,
        visit_type: effectiveVisit || undefined,
        age: age.trim() || undefined,
        dob: dob.trim() || undefined,
        gender: gender.trim() || undefined,
        formatted_vitals: vitals.trim() || undefined,
        formatted_test_results: testResults.trim() || undefined,
        formatted_previous_visits: previousVisits.trim() || undefined,
        language: config.languageMode?.startsWith('ml') ? 'ml' : 'en',
      });
      setPreSummary(res.pre_summary);
      persistDefaults();
      toast.success('Pre-summary ready.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Pre-summary failed');
    }
  };

  const handleSummarize = async () => {
    if (!hasTranscript) return;
    try {
      const res = await summarizeSync({
        text: effectiveTranscript,
        departmentId: department.trim() || undefined,
        visitType: effectiveVisit || undefined,
        testResultsText: testResults.trim() || undefined,
        previousVisitsText: previousVisits.trim() || undefined,
        ...(preSummary
          ? { preSummaryText: preSummary, includePreSummaryInContext: true }
          : {}),
        useEnhancedFormat: useEnhanced,
      });
      setSummary(res);
      persistDefaults();
      toast.success('Summary generated.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Summarization failed');
    }
  };

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Summarization</CardTitle>
        <CardDescription>
          Pre-summarize the clinical context, then summarize the transcript through{' '}
          <code className="font-mono text-xs">useSMR()</code> (v1-compat SMR API). Pick a real tenant department so the gateway can match
          a governed instruction template.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* Department + visit type */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="summary-department">Department</Label>
            {deptState === 'loading' ? (
              <Skeleton className="h-9 w-full" />
            ) : deptState === 'list' && !deptIsCustom ? (
              <Select
                value={deptOptions.some((o) => o.value === department) ? department : ''}
                onValueChange={(v) => {
                  if (v === CUSTOM_DEPT) {
                    setDeptIsCustom(true);
                    setDepartment('');
                  } else {
                    setDepartment(v);
                  }
                }}
              >
                <SelectTrigger id="summary-department" aria-label="Department">
                  <SelectValue placeholder="Select a department" />
                </SelectTrigger>
                <SelectContent>
                  {deptOptions.map((o) => (
                    <SelectItem key={o.id} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_DEPT}>Custom…</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="summary-department"
                aria-label="Department"
                placeholder="Enter department name or code"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
              />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="summary-visit-type">Visit type</Label>
            <Select
              value={visitIsCustom ? CUSTOM_VISIT : visitType}
              onValueChange={(v) => {
                if (v === CUSTOM_VISIT) {
                  setVisitIsCustom(true);
                } else {
                  setVisitIsCustom(false);
                  setVisitType(v);
                }
              }}
            >
              <SelectTrigger id="summary-visit-type" aria-label="Visit type">
                <SelectValue placeholder="Select a visit type" />
              </SelectTrigger>
              <SelectContent>
                {VISIT_TYPE_PRESETS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_VISIT}>Custom…</SelectItem>
              </SelectContent>
            </Select>
            {visitIsCustom ? (
              <Input
                aria-label="Custom visit type"
                placeholder="Enter a visit type"
                value={customVisit}
                onChange={(e) => setCustomVisit(e.target.value)}
              />
            ) : null}
          </div>
        </div>

        {/* Clinical context */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="summary-age">Age</Label>
            <Input id="summary-age" placeholder="45" value={age} onChange={(e) => setAge(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="summary-dob">Date of birth</Label>
            <Input id="summary-dob" placeholder="1980-04-12" value={dob} onChange={(e) => setDob(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="summary-gender">Gender</Label>
            <Input id="summary-gender" placeholder="female" value={gender} onChange={(e) => setGender(e.target.value)} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="summary-vitals">Vitals</Label>
          <Textarea
            id="summary-vitals"
            placeholder="BP 128/82, HR 76, Temp 37.1°C, SpO2 98%"
            value={vitals}
            onChange={(e) => setVitals(e.target.value)}
            className="min-h-16"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="summary-test-results">Test results</Label>
          <Textarea
            id="summary-test-results"
            placeholder="CBC within normal limits; troponin negative…"
            value={testResults}
            onChange={(e) => setTestResults(e.target.value)}
            className="min-h-16"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="summary-previous-visits">Previous visits</Label>
          <Textarea
            id="summary-previous-visits"
            placeholder="2026-01-10 follow-up: stable, continue current meds…"
            value={previousVisits}
            onChange={(e) => setPreviousVisits(e.target.value)}
            className="min-h-16"
          />
        </div>

        {/* Transcript source */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="summary-transcript">Transcript</Label>
            <Badge variant="secondary">
              {pasteTranscript.trim() ? 'pasted' : `${transcriptLines.length} live line${transcriptLines.length === 1 ? '' : 's'}`}
            </Badge>
          </div>
          <Textarea
            id="summary-transcript"
            placeholder="Paste a transcript here, or leave empty to use the live transcript lines above."
            value={pasteTranscript}
            onChange={(e) => setPasteTranscript(e.target.value)}
            className="min-h-24"
          />
        </div>

        {/* Enhanced-format toggle */}
        <div className="flex items-center gap-2">
          <Switch id="summary-enhanced" checked={useEnhanced} onCheckedChange={setUseEnhanced} />
          <Label htmlFor="summary-enhanced">Enhanced format</Label>
        </div>

        {/* Results */}
        {loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : null}

        {preSummary ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Pre-summary</h3>
              <Badge variant="secondary">AI</Badge>
            </div>
            <div className="bg-muted overflow-x-auto rounded p-3 text-sm whitespace-pre-wrap">{preSummary}</div>
          </div>
        ) : null}

        {summary ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Summary</h3>
              <Badge variant="secondary">AI</Badge>
            </div>
            <SummaryView summary={summary} />
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={handlePreSummarize} disabled={loading}>
          Pre-summarize
        </Button>
        <Button onClick={handleSummarize} disabled={loading || !hasTranscript}>
          Summarize
        </Button>
        {!hasTranscript ? (
          <span className="text-muted-foreground self-center text-xs">Record or paste a transcript to enable Summarize.</span>
        ) : null}
      </CardFooter>
    </Card>
  );
}
