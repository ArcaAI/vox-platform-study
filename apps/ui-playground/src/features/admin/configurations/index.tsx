import { Main } from '@/components/layout/main';
import { useAuthStore } from '@/store/auth-store';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import {
  MultiColumnLayout,
  type MultiColumnConfig,
  type MultiColumnContentConfig,
  type MultiColumnState,
} from '@arcaai/ui/multi-column-layout';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  useMyTenantConfigs,
  useTenantConfigs,
  useTenantsInfinite,
  useUpdateMyTenantConfigs,
  useUpdateTenantConfigs,
  type Tenant,
  type TenantConfig,
} from '../api/tenants';

function tryFormatJsonString(input: string): string {
  try {
    const parsed = JSON.parse(input);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return input;
  }
}

function isValidJsonString(input: string): boolean {
  try {
    JSON.parse(input);
    return true;
  } catch {
    return false;
  }
}

function ConfigValueEditor({
  config,
  value,
  onChange,
}: {
  config: TenantConfig;
  value: string;
  onChange: (next: string) => void;
}) {
  const type = String(config.dataType ?? 'STRING').toUpperCase();
  if (type === 'BOOLEAN') {
    return (
      <select
        className="bg-background h-9 rounded-md border px-2 text-sm"
        aria-label="Boolean configuration value"
        title="Boolean configuration value"
        value={value}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
          onChange(event.target.value)
        }
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (type === 'JSON' || value.length > 120 || value.includes('\n')) {
    return (
      <textarea
        className="bg-background min-h-52 w-full rounded-md border p-2 font-mono text-sm"
        aria-label="Configuration value editor"
        title="Configuration value editor"
        value={value}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
          onChange(event.target.value)
        }
      />
    );
  }
  return (
    <Input
      value={value}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
        onChange(event.target.value)
      }
    />
  );
}

export default function ConfigurationManagementPage() {
  const roles = useAuthStore((s: { user?: { roles?: string[] } | null }) => s.user?.roles ?? []);
  const tenantId = useAuthStore((s: { tenantId: string }) => s.tenantId);
  const tenantName = useAuthStore((s: { tenantName: string }) => s.tenantName);
  const isSuperOrGlobalAdmin = roles.includes('SUPER_ADMIN') || roles.includes('GLOBAL_ADMIN');

  const [tenantSearch, setTenantSearch] = useState('');
  const [configSearch, setConfigSearch] = useState('');
  const [selectedTenantId, setSelectedTenantId] = useState(tenantId || '');
  const [selectedConfigId, setSelectedConfigId] = useState('');
  const [draftValue, setDraftValue] = useState('');
  const [draftError, setDraftError] = useState<string | null>(null);

  const {
    data: tenantsPages,
    isLoading: tenantsLoading,
    isRefetching: tenantsRefreshing,
    hasNextPage: tenantsHasMore,
    fetchNextPage: fetchNextTenants,
    refetch: refetchTenants,
    isFetchingNextPage: tenantsLoadingMore,
  } = useTenantsInfinite(25, { enabled: isSuperOrGlobalAdmin });

  const allTenants = useMemo<Tenant[]>(() => {
    if (!isSuperOrGlobalAdmin) {
      if (!tenantId) return [];
      return [{
        id: tenantId,
        name: tenantName || tenantId,
        key: tenantId,
        resourceStatus: 'ENABLED',
        createdAt: '',
        updatedAt: '',
      } as Tenant];
    }
    return tenantsPages?.pages.flatMap((page) => page.data) ?? [];
  }, [isSuperOrGlobalAdmin, tenantId, tenantName, tenantsPages]);

  const filteredTenants = useMemo(
    () =>
      allTenants.filter((item) =>
        `${item.name} ${item.key}`.toLowerCase().includes(tenantSearch.toLowerCase()),
      ),
    [allTenants, tenantSearch],
  );

  const effectiveTenantIdentifier = isSuperOrGlobalAdmin ? selectedTenantId : tenantId;

  const tenantConfigsQuery = useTenantConfigs(
    effectiveTenantIdentifier || '',
    { page: 1, limit: 300 },
    {
      enabled: isSuperOrGlobalAdmin && !!effectiveTenantIdentifier,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 60 * 1000,
    },
  );
  const myConfigsQuery = useMyTenantConfigs({
    enabled: !isSuperOrGlobalAdmin,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 60 * 1000,
  });
  const updateTenantConfigs = useUpdateTenantConfigs();
  const updateMyTenantConfigs = useUpdateMyTenantConfigs();

  const configScopeKey = useMemo(() => {
    if (isSuperOrGlobalAdmin) return effectiveTenantIdentifier || '';
    return 'my-tenant-configs';
  }, [effectiveTenantIdentifier, isSuperOrGlobalAdmin]);

  const activeConfigsQuery = isSuperOrGlobalAdmin ? tenantConfigsQuery : myConfigsQuery;
  const configs = activeConfigsQuery.data?.data ?? [];
  const configsLoading = activeConfigsQuery.isLoading;
  const configsRefreshing = activeConfigsQuery.isRefetching;

  useEffect(() => {
    setSelectedConfigId('');
    setDraftValue('');
    setDraftError(null);
  }, [configScopeKey]);

  const filteredConfigs = useMemo(
    () =>
      configs.filter((config) =>
        `${config.name} ${config.key} ${config.namespace ?? ''}`
          .toLowerCase()
          .includes(configSearch.toLowerCase()),
      ),
    [configs, configSearch],
  );

  useEffect(() => {
    if (selectedConfigId && !filteredConfigs.some((config) => config.id === selectedConfigId)) {
      setSelectedConfigId('');
      setDraftValue('');
    }
  }, [filteredConfigs, selectedConfigId]);

  const selectedConfig = useMemo(
    () => filteredConfigs.find((config) => config.id === selectedConfigId),
    [filteredConfigs, selectedConfigId],
  );

  const currentValue = selectedConfig ? draftValue : '';
  const isDirty = !!selectedConfig && currentValue !== String(selectedConfig.value ?? '');
  const isJsonType = String(selectedConfig?.dataType ?? 'STRING').toUpperCase() === 'JSON';

  useEffect(() => {
    if (!selectedConfig) {
      setDraftError(null);
      return;
    }
    if (isJsonType && currentValue.trim().length > 0 && !isValidJsonString(currentValue)) {
      setDraftError('Invalid JSON: please fix syntax before saving.');
      return;
    }
    setDraftError(null);
  }, [currentValue, isJsonType, selectedConfig]);

  const handleSave = () => {
    if (!selectedConfig) return;
    if (String(selectedConfig.dataType ?? 'STRING').toUpperCase() === 'JSON') {
      if (currentValue.trim().length > 0 && !isValidJsonString(currentValue)) {
        setDraftError('Invalid JSON: please fix syntax before saving.');
        return;
      }
    }
    if (isSuperOrGlobalAdmin) {
      updateTenantConfigs.mutate({
        identifier: effectiveTenantIdentifier,
        configs: [{ id: selectedConfig.id, value: currentValue }],
      });
      return;
    }
    updateMyTenantConfigs.mutate([{ id: selectedConfig.id, value: currentValue }]);
  };

  const tenantColumn: MultiColumnConfig<Tenant> = {
    id: 'config-tenants',
    title: 'Tenants',
    subtitle: 'Select tenant',
    width: '220px',
    showItemCount: true,
    keyExtractor: (tenant: Tenant) => tenant.id,
    estimateItemSize: 62,
    headerControls: (
      <Input
        value={tenantSearch}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setTenantSearch(event.target.value)}
        placeholder="Search tenant..."
      />
    ),
    renderItem: (tenant: Tenant) => (
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{tenant.name}</p>
          <p className="text-muted-foreground truncate text-xs">{tenant.key}</p>
        </div>
      </div>
    ),
    onRefresh: isSuperOrGlobalAdmin
      ? () => {
        void refetchTenants();
      }
      : undefined,
    isRefreshing: tenantsRefreshing,
    emptyTitle: 'No tenants',
  };

  const tenantState: MultiColumnState<Tenant> = {
    data: filteredTenants,
    isLoading: tenantsLoading,
    selectedId: isSuperOrGlobalAdmin ? selectedTenantId : tenantId,
    onSelect: (id: string) => {
      if (isSuperOrGlobalAdmin && id === selectedTenantId) return;
      if (isSuperOrGlobalAdmin) setSelectedTenantId(id);
      setSelectedConfigId('');
    },
    hasMore: !!tenantsHasMore,
    onLoadMore: () => fetchNextTenants(),
    isLoadingMore: tenantsLoadingMore,
  };

  const configColumn: MultiColumnConfig<TenantConfig> = {
    id: 'config-items',
    title: 'Configurations',
    subtitle: `${filteredConfigs.length} item(s)`,
    width: '320px',
    showItemCount: true,
    keyExtractor: (config: TenantConfig) => config.id,
    estimateItemSize: 72,
    headerControls: (
      <Input
        value={configSearch}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setConfigSearch(event.target.value)}
        placeholder="Search configuration..."
      />
    ),
    renderItem: (config: TenantConfig) => (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{config.name || config.key}</p>
          <Badge variant="outline">{String(config.dataType ?? 'STRING')}</Badge>
        </div>
        <p className="text-muted-foreground truncate font-mono text-xs">{config.key}</p>
      </div>
    ),
    emptyTitle: 'No configurations',
    emptyDescription: 'No settings matched your filters.',
    onRefresh: configScopeKey
      ? () => {
        void activeConfigsQuery.refetch();
      }
      : undefined,
    isRefreshing: configsRefreshing,
  };

  const configState: MultiColumnState<TenantConfig> = {
    data: filteredConfigs,
    isLoading: configsLoading,
    selectedId: selectedConfigId,
    onSelect: (id: string) => {
      setSelectedConfigId(id);
      const config = filteredConfigs.find((row) => row.id === id);
      const raw = String(config?.value ?? '');
      const dt = String(config?.dataType ?? 'STRING').toUpperCase();
      setDraftValue(dt === 'JSON' ? tryFormatJsonString(raw) : raw);
      setDraftError(null);
    },
  };

  const detailColumn: MultiColumnContentConfig = {
    type: 'content',
    id: 'config-detail',
    title: 'Configuration Details',
    subtitle: selectedConfig?.key || 'Select a setting',
    width: '1fr',
    onRefresh: selectedConfig
      ? () => {
        void activeConfigsQuery.refetch();
      }
      : undefined,
    isRefreshing: configsRefreshing,
    renderContent: () => {
      if (!selectedConfig) {
        return (
          <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
            Select a configuration to view and edit its value.
          </div>
        );
      }
      return (
        <div className="flex h-full flex-col gap-4 p-4">
          <div>
            <p className="text-sm font-semibold">{selectedConfig.name || selectedConfig.key}</p>
            <p className="text-muted-foreground font-mono text-xs">{selectedConfig.key}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{selectedConfig.namespace || 'general'}</Badge>
            <Badge variant="outline">{String(selectedConfig.dataType ?? 'STRING')}</Badge>
          </div>
          <ConfigValueEditor
            config={selectedConfig}
            value={currentValue}
            onChange={setDraftValue}
          />
          {draftError && (
            <p className="text-destructive text-xs" aria-live="polite" role="status">
              {draftError}
            </p>
          )}
          <div className="mt-auto flex items-center justify-end gap-2">
            <Button
              variant="outline"
              disabled={!selectedConfig}
              onClick={() => setDraftValue(String(selectedConfig.value ?? ''))}
            >
              Reset
            </Button>
            <Button
              disabled={!isDirty || !!draftError || updateTenantConfigs.isPending || updateMyTenantConfigs.isPending}
              onClick={handleSave}
            >
              Save
            </Button>
          </div>
        </div>
      );
    },
  };

  const detailState: MultiColumnState<never> = {
    data: [],
    isLoading: false,
    selectedId: null,
    onSelect: () => {},
    enabled: !!selectedConfigId,
  };

  return (
    <Main>
      <div className="mb-4">
        <h2 className="text-2xl font-bold tracking-tight">Configuration Management</h2>
        <p className="text-muted-foreground mt-1">
          Manage tenant settings with type-aware editing and API-backed persistence.
        </p>
      </div>
      <MultiColumnLayout
        columns={[tenantColumn, configColumn, detailColumn]}
        columnStates={[tenantState, configState, detailState]}
        height="calc(100vh - 12rem)"
      />
    </Main>
  );
}
