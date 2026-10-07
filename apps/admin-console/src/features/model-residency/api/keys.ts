export const modelResidencyKeys = {
  root: ['model-residency'] as const,
  catalogue: () => [...modelResidencyKeys.root, 'catalogue'] as const,
  readiness: () => [...modelResidencyKeys.root, 'readiness'] as const,
};
