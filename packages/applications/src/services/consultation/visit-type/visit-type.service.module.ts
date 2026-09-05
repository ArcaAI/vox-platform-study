import { Module } from '@nestjs/common';
import { VisitTypeService } from './visit-type.service';

/**
 * `VisitTypeService` DI module.
 *
 * Deliberately TINY, and provided as a module rather than as a provider copied
 * into eight consumer modules: the visit-type axis is read by prompt
 * resolution, both summary services, both summary processors, the harness
 * assemble path and gate-edit mining, and one shared import is what keeps those
 * eight from drifting into eight slightly different wirings. Since TASK-882 the
 * service has no dependency at all (the tenant catalogue it used to read is gone).
 */
@Module({
  providers: [VisitTypeService],
  exports: [VisitTypeService],
})
export class VisitTypeServiceModule {}
