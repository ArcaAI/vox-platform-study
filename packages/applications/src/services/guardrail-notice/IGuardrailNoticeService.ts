import type { HoldResolution } from '@arcaai/types';
import type {
  GuardrailHoldResumeResult,
  GuardrailNoticeAckResult,
  GuardrailNoticeCommandOptions,
  GuardrailNoticeListResult,
} from './guardrail-notice.service';

export const IGuardrailNoticeService = Symbol('IGuardrailNoticeService');

/** TASK-1050 W2e — the consultation's guardrail notices: list, acknowledge, resume a hold. */
export interface IGuardrailNoticeService {
  list(consultationId: string): Promise<GuardrailNoticeListResult>;
  acknowledge(consultationId: string, noticeId: string, options: GuardrailNoticeCommandOptions): Promise<GuardrailNoticeAckResult>;
  resumeHold(
    consultationId: string,
    body: { noticeId: string; resolution: HoldResolution },
    options: GuardrailNoticeCommandOptions,
  ): Promise<GuardrailHoldResumeResult>;
}
