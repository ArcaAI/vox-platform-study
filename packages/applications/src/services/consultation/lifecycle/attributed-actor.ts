import {
  assertAttributedClinicianInTenant,
  resolveAttributedClinician,
  tenantRoleReaderFor,
  type AttributionSession,
  type ClinicalCaller,
  type MembershipRepositories,
} from '../summary/clinician-attribution';

export interface ResolveAttributedActorInput {
  tenantId: string;
  /** `clinicianUserId` as the caller sent it. */
  named: string | undefined;
  /** The controller-resolved credential; absent ⇒ derived from the request context below. */
  caller: ClinicalCaller | undefined;
  requestUser: AttributionSession | null | undefined;
  requestServiceAccount: { id: string } | null | undefined;
  repositories: MembershipRepositories;
}

/**
 * The clinician a clinical write is attributed to, and the credential that submitted it — the
 * three steps every write on the finish half of the consultation plane shares (sign-off, edit,
 * close), so a clinician who may sign a note and one who may close its session are the same
 * person:
 *
 *  1. derive the CREDENTIAL when the controller named none (a service account on the request
 *     context, else the human JWT);
 *  2. apply the RULE (`resolveAttributedClinician`) — a 400 naming what is wrong;
 *  3. assert MEMBERSHIP for a named third party — a 404, never a 403. Skipped when the resolved
 *     clinician IS the caller, who proved membership by authenticating.
 */
export async function resolveAttributedActor(input: ResolveAttributedActorInput): Promise<{ clinicianId: string; caller: ClinicalCaller }> {
  const { tenantId, named, requestUser, requestServiceAccount, repositories } = input;
  const requestUserId = requestUser?.id ?? undefined;
  const caller: ClinicalCaller =
    input.caller ??
    (requestServiceAccount
      ? { credentialClass: 'service-account', principalId: requestServiceAccount.id }
      : { credentialClass: 'jwt', principalId: requestUserId ?? '' });

  const clinicianId = await resolveAttributedClinician({
    named,
    caller,
    tenantId,
    requestUser,
    readTenantRoles: tenantRoleReaderFor(repositories.userRoleAssignmentRepository),
  });

  if (clinicianId !== requestUserId) {
    await assertAttributedClinicianInTenant(repositories, clinicianId, tenantId);
  }

  return { clinicianId, caller };
}
