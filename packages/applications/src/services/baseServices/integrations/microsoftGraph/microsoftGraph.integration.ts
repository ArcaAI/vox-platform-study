import { Client } from '@microsoft/microsoft-graph-client';
import { ConfidentialClientApplication } from '@azure/msal-node';
import {
  MsGraphAccessToken,
  MsGraphUser,
  MsGraphEmailMessage,
  MsGraphUserEmails,
  MsGraphUserWithGroups,
  MsGraphGroup,
  MsGraphSharePointSite,
  MsGraphSharePointDrive,
  MsGraphSharePointDriveItem,
} from './microsoftGraphTypes';
import { Injectable, Logger } from '@nestjs/common';

/**
 * MicrosoftGraphIntegration is a service that provides methods to interact with Microsoft Graph API.
 * It handles authentication and provides various functionalities such as fetching user details,
 * sending emails, and accessing SharePoint resources.
 */
@Injectable()
export class MicrosoftGraphIntegration {
  private readonly logger = new Logger(MicrosoftGraphIntegration.name);
  private pca: ConfidentialClientApplication; // Instance of ConfidentialClientApplication for authentication
  private client: Client; // Instance of Client to interact with Microsoft Graph API

  /**
   * Creates an instance of MicrosoftGraphIntegration.
   * @param clientId - The client ID of the application registered in Azure AD.
   * @param clientSecret - The client secret of the application registered in Azure AD.
   * @param tenantId - The tenant ID of the Azure AD.
   * @param scopes - The scopes required for the Microsoft Graph API.
   */
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly tenantId: string,
    private readonly scopes: string[],
  ) {
    this.pca = new ConfidentialClientApplication({
      auth: {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        authority: `https://login.microsoftonline.com/${this.tenantId}`,
      },
    });

    this.client = Client.initWithMiddleware({
      authProvider: {
        getAccessToken: async () => {
          const authResponse = await this.getAccessToken();
          return authResponse.accessToken; // Returns the access token for authentication
        },
      },
    });
  }

  /**
   * Retrieves an access token for Microsoft Graph API using client credentials.
   * @returns A promise that resolves to an MsGraphAccessToken object containing the access token and its expiration.
   */
  private async getAccessToken(): Promise<MsGraphAccessToken> {
    const tokenRequest = {
      scopes: this.scopes, // Scopes required for the token
    };

    try {
      const response = await this.pca.acquireTokenByClientCredential(tokenRequest);

      if (response) {
        return {
          accessToken: response.accessToken,
          expiresOn: response.expiresOn,
          scopes: response.scopes,
        };
      }
      throw new Error('MsGraph Error acquiring token');
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error acquiring token',
        error: (error as Error).message,
        tenantId: this.tenantId,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }

  /**
   * Fetches the details of a user by their user ID.
   * @param userId - The ID of the user to fetch details for.
   * @returns A promise that resolves to an MsGraphUser object containing user details.
   */
  public async fetchUserDetails(userId: string): Promise<MsGraphUser> {
    try {
      const userDetails = await this.client.api(`/users/${userId}`).get();
      return userDetails; // Returns the user details
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error fetching user details',
        userId,
        error: (error as Error).message,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }

  /**
   * Sends an email from a specified user.
   * @param fromUserId - The ID of the user sending the email.
   * @param subject - The subject of the email.
   * @param content - The content of the email.
   * @param toRecipients - An array of email addresses to send the email to.
   * @returns A promise that resolves when the email is sent.
   */
  public async sendEmail(fromUserId: string, subject: string, content: string, toRecipients: string[]): Promise<void> {
    const email = {
      message: {
        subject: subject,
        body: {
          contentType: 'Text',
          content: content,
        },
        toRecipients: toRecipients.map((email) => ({
          emailAddress: { address: email },
        })),
      },
      saveToSentItems: 'true', // Indicates whether to save the email to sent items
    };

    try {
      await this.client.api(`/users/${fromUserId}/sendMail`).post(email);
      this.logger.debug({
        message: 'Email sent successfully',
        fromUserId,
        recipientCount: toRecipients.length,
      });
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error sending email',
        fromUserId,
        recipientCount: toRecipients.length,
        error: (error as Error).message,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }

  /**
   * Fetches emails from the inbox of a specified email address.
   * @param emailAddress - The email address to fetch emails from.
   * @param quantity - The number of emails to fetch.
   * @returns A promise that resolves to an array of MsGraphEmailMessage objects.
   */
  public async fetchEmailsByEmailAddress(emailAddress: string, quantity: number): Promise<MsGraphEmailMessage[]> {
    try {
      const messages = await this.client
        .api(`/users/${emailAddress}/mailFolders/Inbox/messages`)
        .select('subject,from,receivedDateTime,body')
        .top(quantity)
        .get();
      return messages.value; // Returns the fetched email messages
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error reading emails',
        emailAddress,
        quantity,
        error: (error as Error).message,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }

  /**
   * Retrieves all SharePoint sites accessible by the application.
   * @returns A promise that resolves to an array of MsGraphSharePointSite objects.
   */
  public async getSharePointSites(): Promise<MsGraphSharePointSite[]> {
    try {
      const sites = await this.client.api('/sites').get();
      return sites.value.map((site: MsGraphSharePointSite) => ({
        id: site.id,
        name: site.name,
        webUrl: site.webUrl,
      })); // Returns the list of SharePoint sites
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error fetching SharePoint sites',
        error: (error as Error).message,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }

  /**
   * Retrieves all drives associated with a specified SharePoint site.
   * @param siteId - The ID of the SharePoint site.
   * @returns A promise that resolves to an array of MsGraphSharePointDrive objects.
   */
  public async getSharePointSiteDrives(siteId: string): Promise<MsGraphSharePointDrive[]> {
    try {
      const drives = await this.client.api(`/sites/${siteId}/drives`).get();
      return drives.value.map((drive: MsGraphSharePointDrive) => ({
        id: drive.id,
        name: drive.name,
      })); // Returns the list of drives for the specified site
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error fetching SharePoint site drives',
        siteId,
        error: (error as Error).message,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }

  /**
   * Retrieves all items in a specified SharePoint drive.
   * @param driveId - The ID of the SharePoint drive.
   * @returns A promise that resolves to an array of MsGraphSharePointDriveItem objects.
   */
  public async getSharePointDriveItems(driveId: string): Promise<MsGraphSharePointDriveItem[]> {
    try {
      const items = await this.client.api(`/drives/${driveId}/root/children`).get();
      return items.value.map((item: MsGraphSharePointDriveItem) => ({
        id: item.id,
        name: item.name,
        webUrl: item.webUrl,
      })); // Returns the list of items in the specified drive
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error fetching SharePoint drive items',
        driveId,
        error: (error as Error).message,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }

  /**
   * Fetches emails for all users in the organization.
   * @param quantity - The number of emails to fetch for each user.
   * @returns A promise that resolves to an array of MsGraphUserEmails objects.
   */
  public async fetchAllUserEmails(quantity: number): Promise<MsGraphUserEmails[]> {
    try {
      const users = await this.client.api('/users').get();
      const userEmails: MsGraphUserEmails[] = [];

      for (const user of users.value) {
        const messages = await this.client
          .api(`/users/${user.id}/mailFolders/Inbox/messages`)
          .select('subject,from,receivedDateTime,body')
          .top(quantity)
          .get();

        userEmails.push({
          user: user as MsGraphUser,
          messages: messages.value as MsGraphEmailMessage[],
        }); // Collects emails for each user
      }

      return userEmails; // Returns the collected user emails
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error fetching user emails',
        quantity,
        error: (error as Error).message,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }

  /**
   * Fetches all users along with their group memberships.
   * @returns A promise that resolves to an array of MsGraphUserWithGroups objects.
   */
  public async fetchAllUsersWithGroups(): Promise<MsGraphUserWithGroups[]> {
    try {
      const users = await this.client.api('/users').get();
      const userDetailsWithGroups: MsGraphUserWithGroups[] = [];

      for (const user of users.value) {
        const userGroups = await this.client.api(`/users/${user.id}/memberOf`).select('id,displayName').get();

        const groups = userGroups.value.map((group: MsGraphGroup) => ({
          id: group.id,
          displayName: group.displayName,
        }));

        userDetailsWithGroups.push({
          id: user.id,
          displayName: user.displayName,
          mail: user.mail,
          groups: groups,
        }); // Collects user details along with their groups
      }

      return userDetailsWithGroups; // Returns the collected user details with groups
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error fetching users with groups',
        error: (error as Error).message,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }

  /**
   * Fetches all groups in the organization.
   * @returns A promise that resolves to an array of MsGraphGroup objects.
   */
  public async fetchAllGroups(): Promise<MsGraphGroup[]> {
    try {
      const groups = await this.client.api('/groups').get();
      return groups.value.map((group: MsGraphGroup) => ({
        id: group.id,
        displayName: group.displayName,
      })) as MsGraphGroup[]; // Returns the list of groups
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error fetching groups',
        error: (error as Error).message,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }

  /**
   * Fetches all users in the organization.
   * @returns A promise that resolves to an array of MsGraphUser objects.
   */
  public async fetchAllUsers(): Promise<MsGraphUser[]> {
    try {
      const users = await this.client.api('/users').get();
      return users.value.map((user: MsGraphUser) => ({
        id: user.id,
        displayName: user.displayName,
        mail: user.mail,
      })) as MsGraphUser[]; // Returns the list of users
    } catch (error) {
      this.logger.error({
        message: 'MsGraph error fetching users',
        error: (error as Error).message,
      });
      throw error; // Rethrow the error for handling by the caller
    }
  }
}
