import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ContextMedicalJudgeService } from './context-medical-judge.service';
import { IContextMedicalJudgeService } from './IContextMedicalJudgeService';

/**
 * TASK-1059 C-0 — the runtime context medical judge. Imported by every surface that assembles
 * narrative context for an LLM: the note-input composer, the pre-summary job, agent invocations and
 * the live documentation lane.
 *
 * Depends on no consultation / agent / notice module (it writes its one notice through the domain
 * repository), so any importer can take it without closing a module cycle.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, ConfigModule, HttpModule],
  providers: [ContextMedicalJudgeService, { provide: IContextMedicalJudgeService, useExisting: ContextMedicalJudgeService }],
  exports: [IContextMedicalJudgeService, ContextMedicalJudgeService],
})
export class ContextMedicalJudgeServiceModule {}
