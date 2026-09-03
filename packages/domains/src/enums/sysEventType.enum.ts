export enum SysEventType {
  ResourceCreated = 'SysEvent.ResourceCreated',
  ResourceViewed = 'SysEvent.ResourceViewed',
  ResourceUpdated = 'SysEvent.ResourceUpdated',
  ResourceDeleted = 'SysEvent.ResourceDeleted',
  ResourceArchived = 'SysEvent.ResourceArchived',

  // decision: deliberately left declared-but-unused.
  // Webhook delivery (`webhook-delivery.processor.ts`) matches the ORIGINATING
  // event's own type/resourceType/resourceId (e.g. a `Consultation`
  // `ResourceUpdated`) and records each attempt as a `WebhookRunHistory` row —
  // that row already IS "a webhook ran," so broadcasting a second, separate
  // `WebHookRun` SysEvent for it would be a self-referential loop (a webhook
  // delivery firing another round of webhook matching) with no reader.
  // Superseded, not wired; kept for wire/schema compatibility with anything
  // that already serializes this enum.
  WebHookRun = 'SysEvent.WebHookRun',
  SendContactMessage = 'SysEvent.SendContactMessage',
}
