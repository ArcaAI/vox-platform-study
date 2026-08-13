import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';
import { CoreDatabaseModule, JobQueue } from '@arcaai/domains';
import { UsageLedgerServiceModule } from '../usageLedger';
import { KnowledgeDocumentService } from './knowledge-document.service';
import { KnowledgeIngestClient } from './knowledge-ingest.client';
import { IngestKnowledgeDocumentProcessor } from './ingest-knowledge-document.processor';

/**
 * KnowledgeServiceModule — institutional RAG.
 *
 * Wires the institutional-knowledge CRUD/approval service, the harness ingest
 * HTTP client, and the BullMQ ingestion worker. The IngestKnowledgeDocument
 * queue is registered here; the harness base-URL + service-token config is read
 * via ConfigModule + the @Global SecretsModule (same convention as
 * HarnessGatewayService). CoreDatabaseModule provides the tenant-scoped
 * KnowledgeDocument/KnowledgeChunk repositories. UsageLedgerServiceModule
 * supplies IUsageLedgerService for the `embed` usage-ledger
 * emission in IngestKnowledgeDocumentProcessor (injected @Optional so unit
 * fixtures can still construct it without one).
 */
@Module({
  imports: [
    ConfigModule,
    HttpModule,
    CoreDatabaseModule,
    UsageLedgerServiceModule,
    BullModule.registerQueue({ name: JobQueue.IngestKnowledgeDocument }),
  ],
  providers: [KnowledgeDocumentService, KnowledgeIngestClient, IngestKnowledgeDocumentProcessor],
  exports: [KnowledgeDocumentService],
})
export class KnowledgeServiceModule {}
