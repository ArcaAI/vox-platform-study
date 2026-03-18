export { DocPanel } from './components/doc-panel'
export { DocPanelRoot } from './components/doc-panel-root'
export { DocToggleButton } from './components/doc-toggle-button'
export { useDocPanelStore } from './store/doc-panel-store'

export { findDocKeyFromTarget } from './lib/find-doc-key'
export { loadRegistry } from './registry'

export type {
    DocEntry, DocPanelActions, DocPanelState, DocRegistry,
    RegistryLoader
} from './types'

