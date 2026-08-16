import { CreateConsentGrantRequest, RevokeConsentGrantRequest, ConsentGrantResponse } from './dto';
import { IBaseService } from '../../interfaces';

export interface IConsentGrantService extends IBaseService {
  create(request: CreateConsentGrantRequest): Promise<ConsentGrantResponse>;
  revoke(id: string, request: RevokeConsentGrantRequest): Promise<ConsentGrantResponse>;
  getByPatient(externalPatientId: string): Promise<ConsentGrantResponse[]>;
}
export const IConsentGrantService = Symbol('IConsentGrantService');
