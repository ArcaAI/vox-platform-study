import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SummaryService } from '../summary/summary.service';
import type { SessionNoteSigner } from './session-note-signer';

/**
 * Reaches the signing core in `SummaryService` at call time instead of importing the summary
 * module. The summary module's import closure leads back to the consultation module (via the
 * workflow-exposure plane), and the consultation module imports this one, so a static import
 * here would close a module cycle.
 */
@Injectable()
export class LazySessionNoteSigner implements SessionNoteSigner {
  constructor(private readonly moduleRef: ModuleRef) {}

  private signer(): SessionNoteSigner {
    return this.moduleRef.get(SummaryService, { strict: false });
  }

  prepareSessionSignature(input: Parameters<SessionNoteSigner['prepareSessionSignature']>[0]) {
    return this.signer().prepareSessionSignature(input);
  }

  afterSessionSigned(input: Parameters<SessionNoteSigner['afterSessionSigned']>[0]) {
    return this.signer().afterSessionSigned(input);
  }
}
