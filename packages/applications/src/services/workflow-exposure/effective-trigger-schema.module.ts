import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { EffectiveTriggerSchemaService } from './effective-trigger-schema.service';

/**
 * The context-schema pin resolver both dispatch planes share.
 *
 * Its own module rather than a provider on each consumer: the consultation dispatcher and the
 * exposure plane must resolve a follow-latest trigger IDENTICALLY, and two providers of the same
 * class in two graphs is how that quietly stops being true.
 *
 * `CoreDatabaseModule` is the only import — two repository reads and one pure derivation.
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [EffectiveTriggerSchemaService],
  exports: [EffectiveTriggerSchemaService],
})
export class EffectiveTriggerSchemaModule {}
