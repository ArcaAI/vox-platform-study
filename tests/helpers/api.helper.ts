/**
 * API Test Helpers
 *
 * Utilities for making API requests in tests.
 */

import { APIRequestContext, request, APIResponse } from '@playwright/test';
import { generateTestToken, TestUser, createTestUser } from './auth.helper';

/**
 * API client with authentication
 */
export interface ApiClient {
  request: APIRequestContext;
  token: string;
  user: TestUser;
}

/**
 * API response with typed body
 */
export interface TypedApiResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: { [key: string]: string };
  body: T;
  ok: boolean;
}

const DEFAULT_BASE_URL = process.env.API_URL || 'http://localhost:8968';

/**
 * Create an authenticated API client
 */
export async function createApiClient(
  user?: TestUser,
  baseURL?: string
): Promise<ApiClient> {
  const testUser = user || createTestUser();
  const token = generateTestToken(testUser);

  const apiRequest = await request.newContext({
    baseURL: baseURL || DEFAULT_BASE_URL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  return {
    request: apiRequest,
    token,
    user: testUser,
  };
}

/**
 * Create an unauthenticated API client
 */
export async function createUnauthenticatedClient(
  baseURL?: string
): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: baseURL || DEFAULT_BASE_URL,
    extraHTTPHeaders: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Create an API client with a specific API key
 */
export async function createApiKeyClient(
  apiKey: string,
  baseURL?: string
): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: baseURL || DEFAULT_BASE_URL,
    extraHTTPHeaders: {
      'X-API-Key': apiKey,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Parse API response with typed body
 */
export async function parseResponse<T = unknown>(
  response: APIResponse
): Promise<TypedApiResponse<T>> {
  let body: T;

  try {
    body = await response.json();
  } catch {
    body = (await response.text()) as unknown as T;
  }

  const headers: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(response.headers())) {
    headers[key] = value;
  }

  return {
    status: response.status(),
    statusText: response.statusText(),
    headers,
    body,
    ok: response.ok(),
  };
}

/**
 * Assert that a response is successful (2xx status)
 */
export function expectSuccess(response: APIResponse | TypedApiResponse): void {
  const status = 'status' in response ? response.status : response.status();
  if (status < 200 || status >= 300) {
    throw new Error(`Expected success status (2xx), got ${status}`);
  }
}

/**
 * Assert that a response has a specific status code
 */
export function expectStatus(
  response: APIResponse | TypedApiResponse,
  expectedStatus: number
): void {
  const status = 'status' in response ? response.status : response.status();
  if (status !== expectedStatus) {
    throw new Error(`Expected status ${expectedStatus}, got ${status}`);
  }
}

/**
 * Assert that a response is an error with specific status
 */
export function expectError(
  response: APIResponse | TypedApiResponse,
  expectedStatus: number
): void {
  expectStatus(response, expectedStatus);
}

/**
 * Assert unauthorized response (401)
 */
export function expectUnauthorized(response: APIResponse | TypedApiResponse): void {
  expectStatus(response, 401);
}

/**
 * Assert forbidden response (403)
 */
export function expectForbidden(response: APIResponse | TypedApiResponse): void {
  expectStatus(response, 403);
}

/**
 * Assert not found response (404)
 */
export function expectNotFound(response: APIResponse | TypedApiResponse): void {
  expectStatus(response, 404);
}

/**
 * Assert bad request response (400)
 */
export function expectBadRequest(response: APIResponse | TypedApiResponse): void {
  expectStatus(response, 400);
}

/**
 * Assert validation error response (422)
 */
export function expectValidationError(
  response: APIResponse | TypedApiResponse
): void {
  expectStatus(response, 422);
}

/**
 * Make a GET request with the API client
 */
export async function get<T = unknown>(
  client: ApiClient | APIRequestContext,
  path: string,
  options?: { params?: Record<string, string> }
): Promise<TypedApiResponse<T>> {
  const req = 'request' in client ? client.request : client;
  const response = await req.get(path, { params: options?.params });
  return parseResponse<T>(response);
}

/**
 * Make a POST request with the API client
 */
export async function post<T = unknown>(
  client: ApiClient | APIRequestContext,
  path: string,
  data?: unknown
): Promise<TypedApiResponse<T>> {
  const req = 'request' in client ? client.request : client;
  const response = await req.post(path, { data });
  return parseResponse<T>(response);
}

/**
 * Make a PUT request with the API client
 */
export async function put<T = unknown>(
  client: ApiClient | APIRequestContext,
  path: string,
  data?: unknown
): Promise<TypedApiResponse<T>> {
  const req = 'request' in client ? client.request : client;
  const response = await req.put(path, { data });
  return parseResponse<T>(response);
}

/**
 * Make a PATCH request with the API client
 */
export async function patch<T = unknown>(
  client: ApiClient | APIRequestContext,
  path: string,
  data?: unknown
): Promise<TypedApiResponse<T>> {
  const req = 'request' in client ? client.request : client;
  const response = await req.patch(path, { data });
  return parseResponse<T>(response);
}

/**
 * Make a DELETE request with the API client
 */
export async function del<T = unknown>(
  client: ApiClient | APIRequestContext,
  path: string
): Promise<TypedApiResponse<T>> {
  const req = 'request' in client ? client.request : client;
  const response = await req.delete(path);
  return parseResponse<T>(response);
}

/**
 * Dispose of an API client
 */
export async function disposeClient(
  client: ApiClient | APIRequestContext
): Promise<void> {
  const req = 'request' in client ? client.request : client;
  await req.dispose();
}
