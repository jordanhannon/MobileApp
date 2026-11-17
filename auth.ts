import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type Account = {
  id: string;
  name: string;
  email: string;
  rewardPoints: number;
  role: 'member' | 'staff' | 'admin';
};

type SessionResponse = {
  accessToken: string;
  refreshToken?: string;
  account: Account;
};

type ErrorResponse = {
  error?: {
    code?: string;
    message?: string;
  };
};

type ApiRequestOptions = {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  retryAuth?: boolean;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const REFRESH_TOKEN_KEY = 'green-fork-refresh-token';
let accessToken: string | null = null;
let refreshInFlight: Promise<Account | null> | null = null;

function apiUrl(path: string): string {
  const baseUrl = process.env.EXPO_PUBLIC_API_URL;
  if (!baseUrl) {
    throw new ApiError(0, 'api_not_configured', 'Configure EXPO_PUBLIC_API_URL to connect to the Green Fork API.');
  }
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

async function sendRequest(path: string, options: ApiRequestOptions = {}, token: string | null = null): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Session-Transport': Platform.OS === 'web' ? 'cookie' : 'native',
    ...options.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(apiUrl(path), {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
  });
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text === '' ? undefined : JSON.parse(text);
  } catch {
    throw new ApiError(502, 'invalid_api_response', 'The API returned an invalid response.');
  }

  if (!response.ok) {
    const error = payload as ErrorResponse | undefined;
    throw new ApiError(
      response.status,
      error?.error?.code ?? 'request_failed',
      error?.error?.message ?? 'The request could not be completed.',
    );
  }
  return payload as T;
}

async function readStoredRefreshToken(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

async function storeRefreshToken(token: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
  }
}

async function clearStoredRefreshToken(): Promise<void> {
  if (Platform.OS !== 'web') {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  }
}

async function refreshSession(): Promise<Account | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function performRefresh(): Promise<Account | null> {
  const refreshToken = await readStoredRefreshToken();
  if (Platform.OS !== 'web' && !refreshToken) {
    accessToken = null;
    return null;
  }

  const response = await sendRequest(
    '/auth/refresh',
    { method: 'POST', body: refreshToken ? { refreshToken } : {} },
  );
  if (response.status === 401) {
    accessToken = null;
    await clearStoredRefreshToken();
    return null;
  }
  const session = await parseResponse<SessionResponse>(response);
  accessToken = session.accessToken;
  if (session.refreshToken) await storeRefreshToken(session.refreshToken);
  return session.account;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  let response = await sendRequest(path, options, accessToken);
  if (response.status === 401 && options.retryAuth !== false) {
    const account = await refreshSession();
    if (account && accessToken) {
      response = await sendRequest(path, options, accessToken);
    }
  }
  return parseResponse<T>(response);
}

export async function createAccount(name: string, email: string, password: string): Promise<void> {
  await parseResponse(
    await sendRequest('/auth/register', {
      method: 'POST',
      body: { name, email, password },
      retryAuth: false,
    }),
  );
}

export async function requestEmailVerification(email: string): Promise<void> {
  await parseResponse(
    await sendRequest('/auth/verification/request', { method: 'POST', body: { email }, retryAuth: false }),
  );
}

export async function verifyEmail(email: string, code: string): Promise<void> {
  await parseResponse(
    await sendRequest('/auth/verify-email', { method: 'POST', body: { email, code }, retryAuth: false }),
  );
}

export async function signIn(email: string, password: string): Promise<Account> {
  const response = await parseResponse<SessionResponse>(
    await sendRequest('/auth/login', {
      method: 'POST',
      body: { email, password },
      retryAuth: false,
    }),
  );
  accessToken = response.accessToken;
  if (response.refreshToken) await storeRefreshToken(response.refreshToken);
  return response.account;
}

export async function requestPasswordReset(email: string): Promise<void> {
  await parseResponse(
    await sendRequest('/auth/password-reset/request', {
      method: 'POST',
      body: { email },
      retryAuth: false,
    }),
  );
}

export async function completePasswordReset(email: string, code: string, newPassword: string): Promise<void> {
  await parseResponse(
    await sendRequest('/auth/password-reset/confirm', {
      method: 'POST',
      body: { email, code, newPassword },
      retryAuth: false,
    }),
  );
}

export async function signOut(): Promise<void> {
  const refreshToken = await readStoredRefreshToken();
  await parseResponse(
    await sendRequest('/auth/logout', {
      method: 'POST',
      body: refreshToken ? { refreshToken } : {},
      retryAuth: false,
    }),
  );
  accessToken = null;
  await clearStoredRefreshToken();
}

export async function restoreActiveAccount(): Promise<Account | null> {
  return refreshSession();
}
