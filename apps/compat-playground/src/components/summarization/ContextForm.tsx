import { useEffect, useState } from 'react';
import { Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Textarea } from '@arcaai/ui';
import { fetchDepartments, type DepartmentOption } from '../../lib/departments';
import { fetchDoctors, type DoctorOption } from '../../lib/doctors';

/**
 * The department + visit type + clinical context form for the Summarization
 * tab (split out of `SummaryCard.tsx`). Presentational: the
 * orchestrator (`SummaryCard`) owns `department`/`visitType`/context field
 * state and passes it down controlled — this component owns only UI-local
 * toggle state (list-vs-custom mode) and the department fetch.
*/

/**
 * The preset visit types. v1 recognizes exactly TWO canonical categories —
 * new-referral and follow-up — and the gateway normalizes any string into one
 * of them server-side (`new`/`referral`/`initial`/… → new-referral;
 * `follow`/`review`/`revisit` → follow-up). These two labels mirror that
 * model; free text is still accepted for anything else (fixes finding A4 —
 * see `apps/compat-playground/README.md` "Visit type").
 */
export const VISIT_TYPE_PRESETS = ['New / Referral', 'Follow-up / Review'] as const;
/** Default visit type when no config/localStorage value has been seeded yet. */
export const DEFAULT_VISIT_TYPE: string = VISIT_TYPE_PRESETS[0];

/** Sentinel value for the "custom / free text" option in the visit-type select. */
const CUSTOM_VISIT = '__custom__';
/** Sentinel value for the "custom / free text" option in the department select. */
const CUSTOM_DEPT = '__custom__';
/** Sentinel value for the "custom / free text" option in the doctor select. */
const CUSTOM_DOCTOR = '__custom__';
/** Sentinel value for the "no doctor / no DNA style" option. Maps to empty doctorId. */
const NONE_DOCTOR = '__none__';

type DeptFetchState = 'loading' | 'list' | 'freetext';
type DoctorFetchState = 'loading' | 'list' | 'freetext';

export interface ClinicalContextValues {
  age: string;
  dob: string;
  gender: string;
  vitals: string;
  testResults: string;
  previousVisits: string;
}

export interface ContextFormProps {
  apiEndpoint: string;
  apiKey: string;
  department: string;
  onDepartmentChange: (value: string) => void;
  /** Selected doctor's user id (submitted as `doctorId`); empty ⇒ no DNA style. */
  doctorId: string;
  onDoctorIdChange: (value: string) => void;
  /** The EFFECTIVE visit type — either a preset label or free text. */
  visitType: string;
  onVisitTypeChange: (value: string) => void;
  context: ClinicalContextValues;
  onContextChange: <K extends keyof ClinicalContextValues>(key: K, value: ClinicalContextValues[K]) => void;
}

export function ContextForm({
  apiEndpoint,
  apiKey,
  department,
  onDepartmentChange,
  doctorId,
  onDoctorIdChange,
  visitType,
  onVisitTypeChange,
  context,
  onContextChange,
}: ContextFormProps) {
  // Department picker: fetch on mount / when credentials change.
  const [deptState, setDeptState] = useState<DeptFetchState>('loading');
  const [deptOptions, setDeptOptions] = useState<DepartmentOption[]>([]);
  const [deptIsCustom, setDeptIsCustom] = useState(false);

  // Doctor picker: same list/loading/free-text-fallback pattern as department.
  const [doctorState, setDoctorState] = useState<DoctorFetchState>('loading');
  const [doctorOptions, setDoctorOptions] = useState<DoctorOption[]>([]);
  const [doctorIsCustom, setDoctorIsCustom] = useState(false);

  // Visit type list-vs-custom mode. Seeded ONCE from the incoming effective
  // value (mirrors the config/localStorage seeding elsewhere in this app) —
  // this is what fixes finding A4: a seeded value that isn't one of the two
  // presets starts the field in custom mode with a matching sentinel, instead
  // of leaving the `<Select>` with no matching option on first paint.
  const [visitIsCustom, setVisitIsCustom] = useState(() => !(VISIT_TYPE_PRESETS as readonly string[]).includes(visitType));

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

  useEffect(() => {
    let cancelled = false;
    setDoctorState('loading');
    fetchDoctors(apiEndpoint, apiKey)
      .then((options) => {
        if (cancelled) return;
        if (options.length === 0) {
          setDoctorState('freetext');
          return;
        }
        setDoctorOptions(options);
        setDoctorState('list');
      })
      .catch(() => {
        if (!cancelled) setDoctorState('freetext');
      });
    return () => {
      cancelled = true;
    };
  }, [apiEndpoint, apiKey]);

  return (
    <div className="flex flex-col gap-4">
      {/* Department + doctor + visit type */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
                  onDepartmentChange('');
                } else {
                  onDepartmentChange(v);
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
              onChange={(e) => onDepartmentChange(e.target.value)}
            />
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="summary-doctor">Doctor</Label>
          {doctorState === 'loading' ? (
            <Skeleton className="h-9 w-full" />
          ) : doctorState === 'list' && !doctorIsCustom ? (
            <Select
              value={doctorOptions.some((o) => o.id === doctorId) ? doctorId : NONE_DOCTOR}
              onValueChange={(v) => {
                if (v === CUSTOM_DOCTOR) {
                  setDoctorIsCustom(true);
                  onDoctorIdChange('');
                } else if (v === NONE_DOCTOR) {
                  onDoctorIdChange('');
                } else {
                  onDoctorIdChange(v);
                }
              }}
            >
              <SelectTrigger id="summary-doctor" aria-label="Doctor">
                <SelectValue placeholder="None (no DNA style)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_DOCTOR}>None (no DNA style)</SelectItem>
                {doctorOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_DOCTOR}>Custom…</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Input
              id="summary-doctor"
              aria-label="Doctor"
              placeholder="Enter a doctor id (blank = no DNA style)"
              value={doctorId}
              onChange={(e) => onDoctorIdChange(e.target.value)}
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
                onVisitTypeChange('');
              } else {
                setVisitIsCustom(false);
                onVisitTypeChange(v);
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
              value={visitType}
              onChange={(e) => onVisitTypeChange(e.target.value)}
            />
          ) : null}
        </div>
      </div>

      {/* Clinical context */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="summary-age">Age</Label>
          <Input id="summary-age" placeholder="45" value={context.age} onChange={(e) => onContextChange('age', e.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="summary-dob">Date of birth</Label>
          <Input id="summary-dob" placeholder="1980-04-12" value={context.dob} onChange={(e) => onContextChange('dob', e.target.value)} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="summary-gender">Gender</Label>
          <Input id="summary-gender" placeholder="female" value={context.gender} onChange={(e) => onContextChange('gender', e.target.value)} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="summary-vitals">Vitals</Label>
        <Textarea
          id="summary-vitals"
          placeholder="BP 128/82, HR 76, Temp 37.1°C, SpO2 98%"
          value={context.vitals}
          onChange={(e) => onContextChange('vitals', e.target.value)}
          className="min-h-16"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="summary-test-results">Test results</Label>
        <Textarea
          id="summary-test-results"
          placeholder="CBC within normal limits; troponin negative…"
          value={context.testResults}
          onChange={(e) => onContextChange('testResults', e.target.value)}
          className="min-h-16"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="summary-previous-visits">Previous visits</Label>
        <Textarea
          id="summary-previous-visits"
          placeholder="2026-01-10 follow-up: stable, continue current meds…"
          value={context.previousVisits}
          onChange={(e) => onContextChange('previousVisits', e.target.value)}
          className="min-h-16"
        />
      </div>
    </div>
  );
}
