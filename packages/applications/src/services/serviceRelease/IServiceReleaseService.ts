import {
  AttachDigestRequest,
  CurrentServiceResponse,
  ListReleasesQuery,
  PaginatedServiceReleaseResponse,
  RegisterInstanceRequest,
  ServiceReleaseResponse,
} from './dto';

export abstract class IServiceReleaseService {
  /** Boot self-registration + 5-minute heartbeat. Idempotent; silent on repeat. */
  abstract registerInstance(input: RegisterInstanceRequest): Promise<ServiceReleaseResponse>;
  /** Attach a CI-resolved image digest to an existing release. Never creates one. */
  abstract attachDigest(input: AttachDigestRequest): Promise<ServiceReleaseResponse>;
  abstract listReleases(query: ListReleasesQuery): Promise<PaginatedServiceReleaseResponse>;
  abstract listCurrent(environment: string): Promise<CurrentServiceResponse[]>;
  abstract getHistory(serviceName: string): Promise<ServiceReleaseResponse[]>;
}
