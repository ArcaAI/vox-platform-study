import { Main } from '@/components/layout/main';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Link } from '@tanstack/react-router';
import { BookOpen, Brain, FileText, History, Radio, Sparkles, Zap } from 'lucide-react';
import { Skeleton } from '@arcaai/ui/skeleton';
import { SmrStatusBadge } from '../components/smr-status-badge';
import { useSmrProviders } from '../api';

const features = [
  {
    title: 'Pre-Summary Generation',
    description:
      'Generate concise pre-summaries from clinical context, case notes, and historical consultation data. Supports template-based generation.',
    icon: FileText,
    href: '/summarization/pre-summary',
    badge: 'US #127-133',
    color: 'text-amber-500',
  },
  {
    title: 'Full Summary Generation',
    description:
      'Generate comprehensive clinical summaries using transcripts, pre-summaries, templates, and DNA writing styles. Supports SOAP and narrative formats.',
    icon: Sparkles,
    href: '/summarization/summary',
    badge: 'US #134-143',
    color: 'text-blue-500',
  },
  {
    title: 'Live Streaming Demo',
    description:
      'WebSocket bidirectional audio streaming with live transcription, and SSE file upload with streaming transcript and summary generation.',
    icon: Radio,
    href: '/summarization/live-demo',
    badge: 'WS + SSE',
    color: 'text-green-500',
  },
  {
    title: 'Generation History',
    description: 'View all generated summaries and pre-summaries with full metadata, token usage, and processing times. Export and compare results.',
    icon: History,
    href: '/summarization/history',
    badge: 'US #144-150',
    color: 'text-purple-500',
  },
];

export default function SummarizationOverview() {
  const { data: providers, isLoading } = useSmrProviders();
  const availableProviders = providers?.filter((p) => p.is_available) ?? [];
  const totalModels = providers?.reduce((sum, p) => sum + p.models.length, 0) ?? 0;

  return (
    <Main>
      <div className="mb-8">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Summarization</h1>
            <p className="text-muted-foreground mt-1">
              Demonstrate pre-summary and summary generation use-cases with templates, context, and DNA writing styles.
            </p>
          </div>
          <SmrStatusBadge />
        </div>
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        {isLoading ? (
          <>
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="pb-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="mt-2 h-8 w-20" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-3 w-32" />
                </CardContent>
              </Card>
            ))}
          </>
        ) : (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Providers</CardDescription>
                <CardTitle className="text-3xl tabular-nums">
                  {availableProviders.length}
                  <span className="text-muted-foreground text-sm font-normal">/{providers?.length ?? 0}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-xs">Available LLM providers</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Models</CardDescription>
                <CardTitle className="text-3xl tabular-nums">{totalModels}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-xs">Total models across providers</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Capabilities</CardDescription>
                <CardTitle className="text-3xl tabular-nums">8</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-xs">Pre-summary, Summary, DNA, NER, Templates, WebSocket, SSE, Streaming</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {features.map((feature) => (
          <Link key={feature.href} to={feature.href}>
            <Card className="group h-full cursor-pointer transition-all hover:shadow-md hover:border-primary/30">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <feature.icon className={`size-8 ${feature.color}`} />
                  <Badge variant="outline" className="text-[10px]">
                    {feature.badge}
                  </Badge>
                </div>
                <CardTitle className="mt-3 text-lg group-hover:text-primary transition-colors">{feature.title}</CardTitle>
                <CardDescription className="text-xs leading-relaxed">{feature.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>

      <Card className="mt-8">
        <CardHeader>
          <div className="flex items-center gap-2">
            <BookOpen className="size-5" />
            <CardTitle>User Stories Coverage</CardTitle>
          </div>
          <CardDescription>This section demonstrates summarization capabilities from the HOPE user stories.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-2 mb-2">
                <Brain className="size-4 text-amber-500" />
                <span className="text-sm font-medium">Pre-Summary (US #127-133)</span>
              </div>
              <ul className="text-muted-foreground space-y-1 text-xs">
                <li>Generate from historical case notes</li>
                <li>Template-based generation with variables</li>
                <li>Review and edit before use as context</li>
                <li>Source consultation attribution</li>
              </ul>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="size-4 text-blue-500" />
                <span className="text-sm font-medium">Summary (US #134-143)</span>
              </div>
              <ul className="text-muted-foreground space-y-1 text-xs">
                <li>Department prompt template selection</li>
                <li>DNA writing style application</li>
                <li>SOAP and narrative format support</li>
                <li>NER extraction (medications, conditions)</li>
              </ul>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-2 mb-2">
                <History className="size-4 text-purple-500" />
                <span className="text-sm font-medium">Review & Versioning (US #144-150)</span>
              </div>
              <ul className="text-muted-foreground space-y-1 text-xs">
                <li>Version history with diff view</li>
                <li>Doctor edit tracking</li>
                <li>Approval workflow</li>
                <li>NER entity correction</li>
              </ul>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-2 mb-2">
                <Radio className="size-4 text-green-500" />
                <span className="text-sm font-medium">Live Streaming (WS + SSE)</span>
              </div>
              <ul className="text-muted-foreground space-y-1 text-xs">
                <li>WebSocket bidirectional audio + transcript</li>
                <li>SSE file upload transcription streaming</li>
                <li>SSE summary generation token streaming</li>
                <li>Protocol message inspection</li>
              </ul>
            </div>
            <div className="rounded-lg border p-3">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="size-4 text-emerald-500" />
                <span className="text-sm font-medium">SDK Integration (US #67-76)</span>
              </div>
              <ul className="text-muted-foreground space-y-1 text-xs">
                <li>Direct SMR v2 API calls</li>
                <li>Provider and model selection</li>
                <li>Streaming generation support</li>
                <li>Impersonation context forwarding</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </Main>
  );
}
