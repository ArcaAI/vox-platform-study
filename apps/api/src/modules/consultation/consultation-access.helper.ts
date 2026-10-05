import {
  AppAbility,
  CONSULTATION_SHARING_ENABLED_KEY,
  IActiveUserContext,
  IConsultationService,
  PolicyEngine,
  TenantSettingsService,
} from '@arcaai/applications';
import type { ClinicalCaller } from '@arcaai/applications';
import { ForbiddenException, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { RequestWithAuth } from '../../types/request-with-auth';

/**
 * The consultation access check the attachment and feedback controllers share.
 *
 * Same two-layer rule as `ConsultationController`'s private checks (which stay as they are):
 * a service account passes on tenant + scope alone (the tenant is already closed by the
 * service's own lookup), the owning doctor passes, CASL `read`/`manage` passes, and a
 * shared-patient doctor gets READ only when tenant sharing is on. A consultation outside the
 * caller's tenant is a 404, never a 403.
 */
@Injectable()
export class ConsultationAccessHelper {
  private readonly logger = new Logger(ConsultationAccessHelper.name);

  constructor(
    @Inject(IConsultationService) private readonly consultations: IConsultationService,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly policyEngine: PolicyEngine,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /** Who is acting, derived from the REQUEST (CLS cannot tell an API key from a human). */
  callerOf(req: RequestWithAuth | undefined): ClinicalCaller {
    if (req?.serviceAccount?.id) return { serviceAccountId: req.serviceAccount.id, isMachine: true };
    if (req?.apiKey) return { apiKeyId: req.apiKey.id, userId: req.apiKey.userId ?? undefined, isMachine: true };
    if (req?.user?.id) return { userId: req.user.id, isMachine: false };
    const sa = this.cls.get('serviceAccount') as { id?: string } | undefined;
    if (sa?.id) return { serviceAccountId: sa.id, isMachine: true };
    return { userId: this.cls.get('user')?.id, isMachine: false };
  }

  async assertRead(consultationId: string): Promise<void> {
    const consultation = await this.load(consultationId);
    if (this.isServiceAccount()) return;
    const doctorId = this.doctorId();
    if (consultation.doctorId === doctorId) return;
    if (this.abilityAllows('read', consultation.doctorId)) return;
    if (!this.sharingEnabled()) throw new ForbiddenException('You do not have access to this consultation');
    const tenantId = this.cls.get('tenantId') ?? '';
    if (!(await this.consultations.doctorHasPatientRelationship(doctorId, consultation.patientId, tenantId))) {
      throw new ForbiddenException('You do not have access to this consultation');
    }
  }

  async assertWrite(consultationId: string): Promise<void> {
    const consultation = await this.load(consultationId);
    if (this.isServiceAccount()) return;
    if (consultation.doctorId === this.doctorId()) return;
    if (this.abilityAllows('manage', consultation.doctorId)) return;
    throw new ForbiddenException('Only the assigned doctor can modify this consultation');
  }

  private async load(consultationId: string): Promise<{ doctorId: string; patientId: string }> {
    const consultation = await this.consultations.getById(consultationId);
    if (!consultation) throw new NotFoundException(`Consultation ${consultationId} not found`);
    return consultation;
  }

  private isServiceAccount(): boolean {
    const sa = this.cls.get('serviceAccount') as { id?: string } | undefined;
    return typeof sa?.id === 'string';
  }

  private doctorId(): string {
    const id = this.cls.get('user')?.id;
    if (!id) throw new UnauthorizedException('User context not available');
    return id;
  }

  private abilityAllows(action: 'read' | 'manage', doctorId: string): boolean {
    const ability = this.cls.get('userAbility') as AppAbility | undefined;
    if (!ability) return false;
    return this.policyEngine.can(ability, action, 'Consultation', { tenantId: this.cls.get('tenantId'), doctorId } as Record<string, unknown>);
  }

  /** Absence resolves the descriptor default; a resolver failure fails closed. */
  private sharingEnabled(): boolean {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) return false;
    try {
      return this.tenantSettings.resolve<boolean>(CONSULTATION_SHARING_ENABLED_KEY, tenantId).value === true;
    } catch (err) {
      this.logger.warn({ message: 'isSharingEnabled resolution failed; defaulting to CLOSED', tenantId, error: (err as Error)?.message });
      return false;
    }
  }
}
