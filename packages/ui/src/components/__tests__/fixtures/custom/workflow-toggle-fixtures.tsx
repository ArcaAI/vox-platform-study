import { useState } from 'react'
import { WorkflowToggle, type WorkflowMode } from '../../../custom/workflow-toggle'

export function LocalToggle() {
  return (
    <WorkflowToggle
      mode="local"
      onChange={() => {}}
    />
  )
}

export function RemoteToggle() {
  return (
    <WorkflowToggle
      mode="remote"
      onChange={() => {}}
    />
  )
}

export function ToggleWithContent() {
  return (
    <WorkflowToggle
      mode="local"
      onChange={() => {}}
      localContent={<p data-testid="local-content">Local processing active</p>}
      remoteContent={<p data-testid="remote-content">Remote pipeline active</p>}
    />
  )
}

export function InteractiveToggle({
  onChange,
}: {
  onChange?: (mode: WorkflowMode) => void
}) {
  const [mode, setMode] = useState<WorkflowMode>('local')

  return (
    <div>
      <WorkflowToggle
        mode={mode}
        onChange={(m) => {
          setMode(m)
          onChange?.(m)
        }}
        localContent={<p data-testid="local-content">Local processing active</p>}
        remoteContent={<p data-testid="remote-content">Remote pipeline active</p>}
      />
      <span data-testid="current-mode">{mode}</span>
    </div>
  )
}
