/**
 * TASK-932 D-9 — the provider that binds `ILivePreSummaryRunner` to `SummaryService`.
 *
 * A module of its own, one provider wide, so `LiveDocumentationServiceModule` imports THIS rather
 * than `SummaryServiceModule` wholesale. The narrower import is the point: the live module needs
 * exactly one capability from the summary pipeline, and importing the pipeline's whole module
 * would make every future dependency of `SummaryService` a dependency of the live flush path too.
 *
 * There is no cycle: nothing under `SummaryServiceModule` imports the live documentation module
 * (checked — its only importers are `apps/api`'s consultation and harness-admin modules and two
 * DI-wiring tests).
 */
import { Module } from '@nestjs/common';

import { ILivePreSummaryRunner } from '../live-documentation/live-pre-summary.port';
import { LivePreSummaryAdapter } from './live-pre-summary.adapter';
import { SummaryServiceModule } from './summary.service.module';

@Module({
  imports: [SummaryServiceModule],
  providers: [LivePreSummaryAdapter, { provide: ILivePreSummaryRunner, useExisting: LivePreSummaryAdapter }],
  exports: [ILivePreSummaryRunner],
})
export class LivePreSummaryModule {}
