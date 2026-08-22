import { useState } from 'react';
import {
  MasterDetailComposed,
  MasterDetailLayout,
  type MasterDetailColumnDefinition,
  type MasterDetailColumnState,
} from '../../../shadcn/master-detail-layout';

// Playwright CT proxies function props as async RPC to Node, so render-prop
// callbacks (renderItem / keyExtractor) cannot return values synchronously in
// the browser. These fixtures keep those functions inside browser-bundled code
// and expose only serializable props to the test.

interface FruitItem {
  id: string;
  name: string;
}

const fruits: FruitItem[] = [
  { id: 'apple', name: 'Apple' },
  { id: 'banana', name: 'Banana' },
  { id: 'cherry', name: 'Cherry' },
];

const fruitColumn: MasterDetailColumnDefinition<FruitItem> = {
  id: 'fruits',
  title: 'Fruits',
  description: '3 total',
  skeletonCount: 3,
  emptyTitle: 'No fruits',
  emptyDescription: 'No fruits found.',
  renderItem: (item) => <span>{item.name}</span>,
  keyExtractor: (item) => item.id,
};

export function FruitMasterDetail({ selectedId = null }: { selectedId?: string | null }) {
  const columns: MasterDetailColumnDefinition<FruitItem>[] = [fruitColumn];
  const states: MasterDetailColumnState<FruitItem>[] = [{ data: fruits, isLoading: false, selectedId, onSelect: () => {} }];
  return <MasterDetailLayout columns={columns} states={states} />;
}

export function LoadingFruitMasterDetail({ skeletonCount = 4 }: { skeletonCount?: number }) {
  const columns: MasterDetailColumnDefinition<FruitItem>[] = [{ ...fruitColumn, skeletonCount }];
  const states: MasterDetailColumnState<FruitItem>[] = [{ data: [], isLoading: true, selectedId: null, onSelect: () => {} }];
  return <MasterDetailLayout columns={columns} states={states} />;
}

export function EmptyFruitMasterDetail({
  emptyTitle,
  emptyDescription,
  enabled = true,
}: {
  emptyTitle?: string;
  emptyDescription?: string;
  enabled?: boolean;
}) {
  const columns: MasterDetailColumnDefinition<FruitItem>[] = [
    { ...fruitColumn, ...(emptyTitle ? { emptyTitle } : {}), ...(emptyDescription ? { emptyDescription } : {}) },
  ];
  const states: MasterDetailColumnState<FruitItem>[] = [{ data: [], isLoading: false, selectedId: null, onSelect: () => {}, enabled }];
  return <MasterDetailLayout columns={columns} states={states} />;
}

export function TwoColumnFruitMasterDetail() {
  const columns: MasterDetailColumnDefinition<FruitItem>[] = [fruitColumn, { ...fruitColumn, id: 'col2', title: 'Column 2' }];
  const states: MasterDetailColumnState<FruitItem>[] = [
    { data: fruits, isLoading: false, selectedId: null, onSelect: () => {} },
    { data: [], isLoading: false, selectedId: null, onSelect: () => {}, enabled: true },
  ];
  return <MasterDetailLayout columns={columns} states={states} />;
}

interface ComposedFruitMasterDetailProps {
  selectedId?: string | null;
  hasSelection?: boolean;
  detailDescription?: string;
  detailEmptyTitle?: string;
  detailEmptyDescription?: string;
}

export function ComposedFruitMasterDetail({
  selectedId = null,
  hasSelection = false,
  detailDescription,
  detailEmptyTitle,
  detailEmptyDescription,
}: ComposedFruitMasterDetailProps) {
  return (
    <MasterDetailComposed
      listColumns={[fruitColumn]}
      listStates={[{ data: fruits, isLoading: false, selectedId, onSelect: () => {} }]}
      detailColumn={{
        id: 'detail',
        title: 'Detail',
        description: detailDescription,
        emptyTitle: detailEmptyTitle,
        emptyDescription: detailEmptyDescription,
      }}
      detailState={{
        hasSelection,
        content: hasSelection ? <div data-testid="detail-content">Apple detail</div> : null,
      }}
    />
  );
}

export function InteractiveFruitMasterDetail() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const columns: MasterDetailColumnDefinition<FruitItem>[] = [fruitColumn];
  const states: MasterDetailColumnState<FruitItem>[] = [{ data: fruits, isLoading: false, selectedId, onSelect: setSelectedId }];
  return (
    <div>
      <MasterDetailLayout columns={columns} states={states} />
      <span data-testid="selected-fruit">{selectedId ?? ''}</span>
    </div>
  );
}
