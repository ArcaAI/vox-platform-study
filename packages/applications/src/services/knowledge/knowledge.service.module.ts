import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { UsageLedgerServiceModule } from '../usageLedger';
import { KnowledgeDocumentService } from './knowledge-document.service';
import { KnowledgeIngestClient } from './knowledge-ingest.client';
import { KnowledgeVectorCleanupClient } from './knowledge-vector-cleanup.client';
import { IngestKnowledgeDocumentProcessor } from './ingest-knowledge-document.processor';
import { IKnowledgeDocumentService } from './IKnowledgeDocumentService';

/**
 * KnowledgeServiceModule — institutional RAG.
 *
 * Wires the institutional-knowledge CRUD/approval/governance service, the
 * harness ingest + vector-cleanup HTTP clients, and the BullMQ ingestion
 * worker. The IngestKnowledgeDocument queue is registered here; the harness
 * base-URL + service-token config is read via ConfigModule + the @Global
 * SecretsModule (same convention as HarnessGatewayService). CoreDatabaseModule
 * provides the tenant-scoped KnowledgeDocument/KnowledgeChunk repositories.
 * UsageLedgerServiceModule supplies IUsageLedgerService for the `embed`
 * usage-ledger emission in IngestKnowledgeDocumentProcessor (injected
 * @Optional so unit fixtures can still construct it without one).
 *
 * `IKnowledgeDocumentService` is provided via `useExisting` (not `useClass`)
 * so the admin controller (apps/api) resolves the SAME instance the BullMQ
 * processor's sibling providers share, mirroring
 * `ConsultationContextSchemaServiceModule`.
 */
@Module({
  imports: [
    ConfigModule,
    HttpModule,
    CoreDatabaseModule,
    UsageLedgerServiceModule,
    BullModule.registerQueue({ name: JobQueue.IngestKnowledgeDocument }),
  ],
  providers: [
    KnowledgeDocumentService,
    { provide: IKnowledgeDocumentService, useExisting: KnowledgeDocumentService },
    KnowledgeIngestClient,
    KnowledgeVectorCleanupClient,
    IngestKnowledgeDocumentProcessor,
  ],
  exports: [KnowledgeDocumentService, IKnowledgeDocumentService],
})
export class KnowledgeServiceModule {}
