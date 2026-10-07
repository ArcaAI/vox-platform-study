'use client';

import Link from 'next/link';
import { IconCheck, IconExclamationMark } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatDateTime, formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { ErrorState } from '@/shared/state/error-state';
import { useModelResidencyReadiness } from '../api';

/** Where an admin goes to fix a failing check, when there is a screen for it. */
const CHECK_CTA: Partial<Record<string, { href: string; label: string }>> = {
  instances_matched: { href: '/model-residency?show=problems', label: 'Review on overview' },
  gpus_inside_headroom: { href: '/model-residency', label: 'See GPU memory' },
};

const HEADER = (
  <PageHeader
    title="Ready to enforce?"
    meta={<span>In enforce mode the controller loads and unloads models on its own. Every check must pass first.</span>}
  />
);

function BackLink() {
  return (
    <Link
      href="/model-residency"
      className="text-muted-foreground hover:text-foreground inline-flex min-h-8 items-center text-sm underline-offset-4 hover:underline"
    >
      ← Model residency
    </Link>
  );
}

function ReadinessSkeleton() {
  return (
    <div className="flex flex-col gap-6" data-testid="readiness-skeleton" aria-hidden>
      <Skeleton className="h-3 w-full max-w-md" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-16" />
        ))}
      </div>
    </div>
  );
}

export function ReadinessScreen() {
  const query = useModelResidencyReadiness();
  const data = query.data;

  if (!data) {
    return (
      <ScreenTemplate header={HEADER}>
        <div className="flex flex-col gap-4">
          <BackLink />
          {query.isError ? <ErrorState title="Couldn’t load readiness" error={null} onRetry={() => void query.refetch()} /> : <ReadinessSkeleton />}
        </div>
      </ScreenTemplate>
    );
  }

  const blockers = data.total - data.passed;
  const pct = data.total === 0 ? 0 : (data.passed / data.total) * 100;
  const tiles: Array<[string, number]> = [
    ['Loads', data.shadow.loads],
    ['Idle unloads', data.shadow.unloads],
    ['Refused — over budget', data.shadow.refusedOverBudget],
    ['Would load a duplicate', data.shadow.duplicateLoads],
  ];

  return (
    <ScreenTemplate header={HEADER}>
      <div className="flex max-w-3xl flex-col gap-8">
        <div className="flex flex-col gap-3">
          <BackLink />
          <div className="flex items-center gap-3">
            <div
              role="progressbar"
              aria-label="Checks passed"
              aria-valuemin={0}
              aria-valuemax={data.total}
              aria-valuenow={data.passed}
              className="bg-muted h-2 w-full max-w-xs overflow-hidden rounded-full"
            >
              <div className="bg-primary h-full" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-sm tabular-nums">
              {data.passed} of {data.total} passed
            </span>
          </div>
        </div>

        <section aria-labelledby="rd-checks-h" className="flex flex-col gap-2">
          <h2 id="rd-checks-h" className="text-base font-medium">
            Checks
          </h2>
          <ul className="flex flex-col divide-y rounded-md border">
            {data.checks.map((check) => (
              <li key={check.id} className="flex items-start gap-3 p-3">
                <span
                  aria-hidden
                  className={`mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full ${check.passed ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive'}`}
                >
                  {check.passed ? <IconCheck className="size-3.5" /> : <IconExclamationMark className="size-3.5" />}
                </span>
                <div className="flex flex-col gap-0.5">
                  <div className="text-sm font-medium">
                    {check.title} <span className="sr-only">{check.passed ? '— passed' : '— blocking'}</span>
                  </div>
                  <div className="text-muted-foreground text-sm">{check.detail}</div>
                  {!check.passed && CHECK_CTA[check.id] ? (
                    <Link
                      href={CHECK_CTA[check.id]!.href}
                      className="text-primary inline-flex min-h-8 items-center text-sm underline-offset-4 hover:underline"
                    >
                      {CHECK_CTA[check.id]!.label}
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="rd-shadow-h" className="flex flex-col gap-2">
          <h2 id="rd-shadow-h" className="text-base font-medium">
            What the controller would have done
          </h2>
          <p className="text-muted-foreground text-sm">Shadow decisions since gateway start, {formatDateTime(data.shadow.since, 'date')}.</p>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {tiles.map(([label, value]) => (
              <div key={label} className="flex flex-col-reverse rounded-md border p-3">
                <dt className="text-muted-foreground text-xs">{label}</dt>
                <dd className="text-2xl font-semibold tabular-nums">{formatNumber(value)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="rd-enforce-h" className="flex flex-col gap-2 rounded-md border p-4">
          <h2 id="rd-enforce-h" className="text-base font-medium">
            Turning enforce on
          </h2>
          <p className="text-muted-foreground text-sm">
            Enforce is the <code className="font-mono">residency.enforce</code> platform setting. It is not toggled from this screen; this page only
            tells you whether the checks above allow it.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild variant="outline">
              <Link href="/settings-registry">Open the residency.enforce setting</Link>
            </Button>
            <span className="text-muted-foreground text-sm">
              {blockers === 0
                ? 'All checks pass; change the setting in the Settings registry.'
                : `${blockers} ${blockers === 1 ? 'check blocks' : 'checks block'} enforce mode.`}
            </span>
          </div>
        </section>
      </div>
    </ScreenTemplate>
  );
}
