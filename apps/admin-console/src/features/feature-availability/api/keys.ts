/** Query keys for the feature-availability plane. */
export const featureAvailabilityKeys = {
  root: ['feature-availability'] as const,
  /** The caller-scoped gates. */
  effective: () => [...featureAvailabilityKeys.root, 'effective'] as const,
  /** The cross-tenant matrix (super admin only). */
  matrix: () => [...featureAvailabilityKeys.root, 'matrix'] as const,
};
