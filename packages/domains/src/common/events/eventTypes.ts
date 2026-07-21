export enum EventTypes {
  AppSettingsUpdated = 'appSettings.updated',

  NotificationSend = 'notification.send',

  ResourceCreated = 'resource.created',
  ResourceViewed = 'resource.viewed',
  ResourceUpdated = 'resource.updated',
  ResourceDeleted = 'resource.deleted',

  MediaCreated = 'media.created',
  MediaUpdated = 'media.updated',

  UserAuthenticated = 'user.authenticated',
  // The success-only `UserAuthenticated` bracket left failed
  // attempts with no persisted trail; HIPAA §164.312(b) access auditing wants
  // rejected access reviewable, not just granted access.
  UserAuthenticationFailed = 'user.authentication_failed',
  UserCreated = 'user.created',
  UserUpdated = 'user.updated',

  WebhookCreated = 'webhook.created',
  WebhookUpdated = 'webhook.updated',
}
