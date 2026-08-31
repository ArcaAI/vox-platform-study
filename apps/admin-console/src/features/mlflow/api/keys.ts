export const mlflowKeys = {
  root: ['mlflow'] as const,
  status: () => [...mlflowKeys.root, 'status'] as const,
  registeredModels: () => [...mlflowKeys.root, 'registered-models'] as const,
  modelVersions: () => [...mlflowKeys.root, 'model-versions'] as const,
  experiments: () => [...mlflowKeys.root, 'experiments'] as const,
};
