export const modelResidencyKeys = {
  root: ['model-residency'] as const,
  list: () => [...modelResidencyKeys.root, 'list'] as const,
  policies: () => [...modelResidencyKeys.root, 'policies'] as const,
};
