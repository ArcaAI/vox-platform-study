/**
 * TASK-404 — `01 · Components` showcase sections (P2-2).
 *
 * Grouped design-system specimens per the TASK-371 foundations frame + pillars:
 * tokens · typography · shape · status grammar · primitives · metrics. Each
 * group is headed by its `@arcaai/ui` import path so engineers can lift the
 * exact import. Specimen data is clearly labelled sample content.
 */

import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Checkbox } from '@arcaai/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Progress } from '@arcaai/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Spinner } from '@arcaai/ui/spinner';
import { Switch } from '@arcaai/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/tabs';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { MetricChart, MetricTable, ServiceStatusItem, StatCard, StatusDot, type MetricColumn } from '@arcaai/ui/components/metrics';
import { Activity, Inbox, Sparkles, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { COLOR_RAMPS, RADIUS_SCALE, SEMANTIC_ROLES, SPACING_SCALE, STATUS_GRAMMAR, TYPE_SCALE } from './tokens';

/** Section shell: anchored heading + description + content. */
function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-24 space-y-4">
      <div>
        <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** Specimen group: mono import-path header + specimen row. */
function Group({ importPath, title, children }: { importPath: string; title: string; children: ReactNode }) {
  return (
    <Card className="gap-3 p-5" data-slot="showcase-group">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="font-mono text-xs text-muted-foreground">{importPath}</p>
      </div>
      {children}
    </Card>
  );
}

export function TokensSection() {
  return (
    <Section
      id="tokens"
      title="Color tokens"
      description="Semantic roles and the foundation ramps behind them — every surface uses tokens, never hex."
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {SEMANTIC_ROLES.map((role) => (
          <Card key={role.id} className="gap-3 overflow-hidden p-0" data-slot="role-card">
            <div className="flex h-20 items-end justify-between p-4" style={{ background: role.bg, color: role.fg }}>
              <span className="text-2xl font-semibold">Aa</span>
              <span className="font-mono text-xs opacity-90">{role.token}</span>
            </div>
            <div className="space-y-1 px-4 pb-4">
              <p className="text-sm font-semibold">{role.name}</p>
              <p className="text-xs text-muted-foreground">{role.usage}</p>
            </div>
          </Card>
        ))}
      </div>

      <Card className="gap-4 p-5">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold">Foundation ramps</h3>
          <p className="font-mono text-xs text-muted-foreground">--teal-* · --indigo-* · --saffron-* · --green-* · --slate-*</p>
        </div>
        <div className="space-y-3">
          {COLOR_RAMPS.map((ramp) => (
            <div key={ramp.name} className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-xs font-medium capitalize">{ramp.name}</span>
              <div className="flex min-w-0 flex-1 overflow-hidden rounded-md border">
                {ramp.steps.map((s) => (
                  <div key={s.step} title={`--${ramp.name}-${s.step}`} className="h-8 flex-1" style={{ background: s.value }} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </Section>
  );
}

export function TypographySection() {
  return (
    <Section
      id="typography"
      title="Typography"
      description="Inter ramp (Display 30 → Caption 12), tabular numerals for metrics, JetBrains Mono for IDs."
    >
      <Card className="gap-4 p-5">
        <div className="space-y-3">
          {TYPE_SCALE.map((step) => (
            <div key={step.name} className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {step.name} · {step.px}
              </span>
              <span className={step.className}>{step.sample}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 border-t pt-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">Tabular numerals (metrics, uptime, counts)</p>
            <p className="text-lg font-semibold tabular-nums">1,024 · 99.98% · 00:42:17</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">JetBrains Mono (IDs, correlation ids, keys)</p>
            <p className="font-mono text-sm">corr_9f2c-41ab · sk-hope-…-Xk91</p>
          </div>
        </div>
      </Card>
    </Section>
  );
}

export function ShapeSection() {
  return (
    <Section id="shape" title="Shape & spacing" description="10px base radius, the 8-pt rhythm, border-first separation with two shadow levels.">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Group importPath="var(--radius-sm|md|lg|xl)" title="Radius scale">
          <div className="flex flex-wrap items-end gap-4">
            {RADIUS_SCALE.map((r) => (
              <div key={r.name} className="space-y-1 text-center">
                <div className="size-16 border-2 border-primary/60 bg-primary/10" style={{ borderRadius: r.value }} />
                <p className="text-xs font-medium">{r.name}</p>
                <p className="text-[10px] text-muted-foreground">{r.usage}</p>
              </div>
            ))}
            <div className="space-y-1 text-center">
              <div className="flex h-16 items-center">
                <div className="h-8 w-16 rounded-full border-2 border-primary/60 bg-primary/10" />
              </div>
              <p className="text-xs font-medium">full</p>
              <p className="text-[10px] text-muted-foreground">Pills, avatars</p>
            </div>
          </div>
        </Group>
        <Group importPath="8-pt rhythm · 4px base" title="Spacing scale">
          <div className="flex flex-wrap items-end gap-2">
            {SPACING_SCALE.map((px) => (
              <div key={px} className="space-y-1 text-center">
                <div className="mx-auto w-4 rounded-sm bg-ai/30" style={{ height: px }} />
                <p className="text-[10px] tabular-nums text-muted-foreground">{px}</p>
              </div>
            ))}
          </div>
        </Group>
      </div>
    </Section>
  );
}

export function StatusSection() {
  return (
    <Section id="status" title="Status grammar" description="Status is never color-only — a dot or badge always pairs with a text label.">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Group importPath="@arcaai/ui/components/metrics · StatusDot" title="Dot + label">
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {STATUS_GRAMMAR.map((s) => (
              <div key={s.role} className="space-y-0.5">
                <StatusDot colorRole={s.role} label={s.label} />
                <p className="text-xs text-muted-foreground">{s.meaning}</p>
              </div>
            ))}
          </div>
        </Group>
        <Group importPath="@arcaai/ui/components/shared · StatusBadge" title="Status badges">
          <div className="flex flex-wrap items-center gap-2">
            {STATUS_GRAMMAR.map((s) => (
              <StatusBadge key={s.role} label={s.label} colorRole={s.role} />
            ))}
          </div>
        </Group>
      </div>
    </Section>
  );
}

export function PrimitivesSection() {
  return (
    <Section id="primitives" title="Primitives" description="Core @arcaai/ui controls in their default, emphasized, and disabled states.">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Group importPath="@arcaai/ui/button" title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm">
              <Sparkles className="size-4" />
              With icon
            </Button>
          </div>
        </Group>

        <Group importPath="@arcaai/ui/badge" title="Badges">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="ghost">Ghost</Badge>
          </div>
        </Group>

        <Group importPath="@arcaai/ui/input · label · select" title="Form fields">
          <div className="grid max-w-md gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="showcase-input">Tenant name</Label>
              <Input id="showcase-input" placeholder="Sunrise Clinic" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="showcase-input-disabled">Disabled</Label>
              <Input id="showcase-input-disabled" disabled value="Read-only value" readOnly />
            </div>
            <div className="grid gap-1.5">
              <Label>Plan</Label>
              <Select>
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="Select a plan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="basic">Basic</SelectItem>
                  <SelectItem value="pro">Pro</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </Group>

        <Group importPath="@arcaai/ui/switch · checkbox" title="Selection controls">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="flex items-center gap-2 text-sm">
              <Switch defaultChecked aria-label="Enabled switch" /> On
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch aria-label="Disabled switch" disabled /> Disabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox defaultChecked aria-label="Checked checkbox" /> Checked
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox aria-label="Unchecked checkbox" /> Unchecked
            </label>
          </div>
        </Group>

        <Group importPath="@arcaai/ui/tabs" title="Tabs">
          <Tabs defaultValue="overview" className="max-w-md">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="usage">Usage</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="text-sm text-muted-foreground">
              Tab panels keep the surface calm — content swaps in place.
            </TabsContent>
            <TabsContent value="usage" className="text-sm text-muted-foreground">
              Usage specimen panel.
            </TabsContent>
            <TabsContent value="settings" className="text-sm text-muted-foreground">
              Settings specimen panel.
            </TabsContent>
          </Tabs>
        </Group>

        <Group importPath="@arcaai/ui/alert" title="Alerts">
          <div className="grid gap-3">
            <Alert>
              <Activity className="size-4" />
              <AlertTitle>Heads up</AlertTitle>
              <AlertDescription>Neutral inline notice for contextual guidance.</AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <TriangleAlert className="size-4" />
              <AlertTitle>Something failed</AlertTitle>
              <AlertDescription>Destructive alert — calm, specific, recoverable.</AlertDescription>
            </Alert>
          </div>
        </Group>

        <Group importPath="@arcaai/ui/progress · spinner · skeleton" title="Loading & progress">
          <div className="grid max-w-md gap-4">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Determinate progress (value forwarded to Radix — aria-valuenow 64)</p>
              <Progress value={64} aria-label="Sample progress" />
            </div>
            <div className="flex items-center gap-3">
              <Spinner className="size-5" />
              <span className="text-sm text-muted-foreground">Inline spinner</span>
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          </div>
        </Group>

        <Group importPath="@arcaai/ui/empty" title="Empty state">
          <Empty className="border-0 p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>No consultations yet</EmptyTitle>
              <EmptyDescription>Empty states name the object, explain why, and point at the next action.</EmptyDescription>
            </EmptyHeader>
            <Button size="sm" variant="outline">
              Invite a clinician
            </Button>
          </Empty>
        </Group>
      </div>
    </Section>
  );
}

/** Sample series for the MetricChart specimen (clearly-labelled sample data). */
const SAMPLE_CHART_ROWS = [
  { label: 'Mon', newVisits: 12, revisits: 5 },
  { label: 'Tue', newVisits: 18, revisits: 9 },
  { label: 'Wed', newVisits: 9, revisits: 7 },
  { label: 'Thu', newVisits: 21, revisits: 11 },
  { label: 'Fri', newVisits: 16, revisits: 8 },
];

const SAMPLE_TABLE_COLUMNS: MetricColumn[] = [
  { key: 'service', label: 'Service' },
  { key: 'status', label: 'Status' },
  { key: 'p95', label: 'P95', format: 'numeric' },
];

export function MetricsSection() {
  return (
    <Section
      id="metrics"
      title="Metrics primitives"
      description="TASK-377 shared reporting components — the building blocks of Dashboard and Monitoring."
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Group importPath="@arcaai/ui/components/metrics · StatCard" title="Stat cards">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <StatCard label="Active tenants" value="24" delta={{ value: 8, label: 'this week' }} accent="primary" />
            <StatCard label="Error rate" value="0.4%" delta={{ value: 0.2, label: 'vs 1h' }} deltaIntent="negative" accent="warning" />
            <StatCard label="Consultations" value="1,284" hint="Sample data" accent="ai" />
            <StatCard label="Loading state" value={undefined} isLoading />
          </div>
        </Group>

        <Group importPath="@arcaai/ui/components/metrics · MetricChart" title="Metric chart (sample series)">
          <MetricChart
            kind="bar"
            data={SAMPLE_CHART_ROWS}
            xKey="label"
            series={[
              { key: 'newVisits', label: 'New' },
              { key: 'revisits', label: 'Re-visit' },
            ]}
            height={200}
            showLegend
            aria-label="Sample consultation volume bar chart"
          />
        </Group>

        <Group importPath="@arcaai/ui/components/metrics · MetricTable" title="Metric table">
          <MetricTable
            aria-label="Sample service table"
            columns={SAMPLE_TABLE_COLUMNS}
            rows={[
              { service: 'API', status: <StatusDot colorRole="success" label="Healthy" />, p95: <span className="tabular-nums">84 ms</span> },
              { service: 'STT', status: <StatusDot colorRole="warning" label="Degraded" />, p95: <span className="tabular-nums">412 ms</span> },
            ]}
            getRowId={(_, index) => String(index)}
          />
        </Group>

        <Group importPath="@arcaai/ui/components/metrics · ServiceStatusItem" title="Service status items">
          <div className="grid gap-2">
            <ServiceStatusItem name="API" status="healthy" uptimeSeconds={86_400} version="2.1.0" />
            <ServiceStatusItem name="STT" status="degraded" p95Ms={412} />
            <ServiceStatusItem name="Harness" status="checking" />
          </div>
        </Group>
      </div>
    </Section>
  );
}
