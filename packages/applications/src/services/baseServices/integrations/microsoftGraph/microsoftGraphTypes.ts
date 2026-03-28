/**
 * Represents an email message in Microsoft Graph.
 */
export interface MsGraphEmailMessage {
  /** The subject of the email message. */
  subject: string;
  /** The sender of the email message. */
  from: {
    /** The email address of the sender. */
    emailAddress: {
      /** The email address string. */
      address: string;
      /** The name of the sender. */
      name: string;
    };
  };
  /** The date and time the email message was received. */
  receivedDateTime: string;
  /** The body of the email message. */
  body: {
    /** The content type of the body (e.g., 'text' or 'html'). */
    contentType: string;
    /** The actual content of the email message. */
    content: string;
  };
}

/**
 * Represents a user in Microsoft Graph.
 */
export interface MsGraphUser {
  /** The unique identifier of the user. */
  id: string;
  /** The display name of the user. */
  displayName: string;
  /** The email address of the user. */
  mail: string;
}

/**
 * Represents a user and their associated email messages in Microsoft Graph.
 */
export interface MsGraphUserEmails {
  /** The user associated with the email messages. */
  user: MsGraphUser;
  /** The list of email messages for the user. */
  messages: MsGraphEmailMessage[];
}

/**
 * Represents a group in Microsoft Graph.
 */
export interface MsGraphGroup {
  /** The unique identifier of the group. */
  id: string;
  /** The display name of the group. */
  displayName: string;
}

/**
 * Represents a user along with their associated groups in Microsoft Graph.
 */
export interface MsGraphUserWithGroups extends MsGraphUser {
  /** The list of groups the user belongs to. */
  groups: MsGraphGroup[];
}

/**
 * Represents an access token for Microsoft Graph.
 */
export interface MsGraphAccessToken {
  /** The access token string. */
  accessToken: string;
  /** The expiration date and time of the access token. */
  expiresOn: Date | null;
  /** The scopes associated with the access token. */
  scopes: string[];
}

/**
 * Represents a SharePoint site in Microsoft Graph.
 */
export interface MsGraphSharePointSite {
  /** The unique identifier of the SharePoint site. */
  id: string;
  /** The name of the SharePoint site. */
  name: string;
  /** The web URL of the SharePoint site. */
  webUrl: string;
}

/**
 * Represents a SharePoint drive in Microsoft Graph.
 */
export interface MsGraphSharePointDrive {
  /** The unique identifier of the SharePoint drive. */
  id: string;
  /** The name of the SharePoint drive. */
  name: string;
}

/**
 * Represents an item in a SharePoint drive in Microsoft Graph.
 */
export interface MsGraphSharePointDriveItem {
  /** The unique identifier of the SharePoint drive item. */
  id: string;
  /** The name of the SharePoint drive item. */
  name: string;
  /** The web URL of the SharePoint drive item. */
  webUrl: string;
}
