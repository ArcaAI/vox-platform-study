import { HttpException, Inject, Injectable } from '@nestjs/common';
import { AsrAgentResolverService } from '../../stt/agent-resolver/asr-agent-resolver.service';
import { ILoopConfigService } from '../loop/ILoopConfigService';
import { AttachmentKind, deriveSupportedKinds } from './attachment-policy';

/**
 * Which attachment kinds a consultation can process right now — the inputs of the pure
 * {@link deriveSupportedKinds}. `audio` needs an ASR agent that resolves for the consultation; the
 * governing workflow's loop subscriptions decide `document` / `image` (OD-C1: on the default engine
 * a PDF is supported, an image is not until vision extraction exists).
 */
@Injectable()
export class AttachmentCapabilityService {
  constructor(
    private readonly asrResolver: AsrAgentResolverService,
    @Inject(ILoopConfigService) private readonly loopConfig: ILoopConfigService,
  ) {}

  async supportedKinds(tenantId: string, consultationId: string): Promise<AttachmentKind[]> {
    const [asrResolvable, loop] = await Promise.all([
      this.asrResolvable(tenantId, consultationId),
      this.loopConfig.resolveForConsultation(tenantId, consultationId),
    ]);
    const subscriptions = (loop.subscriptions ?? []).flatMap((s) => s.actions ?? []);
    return deriveSupportedKinds({ asrResolvable, governed: loop.enabled === true, subscriptions });
  }

  /**
   * An HTTP refusal from the resolver (no agent assigned, nothing runnable, a provider veto, a
   * gateway without the credential plane) means "cannot transcribe here". Anything else is an
   * infrastructure fault and propagates rather than masquerading as an unsupported kind.
   */
  private async asrResolvable(tenantId: string, consultationId: string): Promise<boolean> {
    try {
      await this.asrResolver.resolve({ tenantId, consultationId, departmentId: null });
      return true;
    } catch (error) {
      if (error instanceof HttpException) return false;
      throw error;
    }
  }
}
