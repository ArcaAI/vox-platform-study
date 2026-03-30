import { UserPreferencesResponse, UpdateUserPreferencesRequest } from './dto';

/**
 * User Preferences Service Interface
 *
 * Provides aggregated preferences for SDK v2 PersonalizationManager.
 * Transforms key-value UserSettings into a typed UserPreferences object.
 */
export interface IUserPreferencesService {
  /**
   * Get aggregated preferences for the authenticated user
   */
  getPreferences(): Promise<UserPreferencesResponse>;

  /**
   * Update preferences (partial update - only update provided fields)
   */
  updatePreferences(request: UpdateUserPreferencesRequest): Promise<UserPreferencesResponse>;

  /**
   * Reset preferences to defaults (deletes all SDK preferences)
   */
  resetPreferences(): Promise<void>;
}

export const IUserPreferencesService = Symbol('IUserPreferencesService');
