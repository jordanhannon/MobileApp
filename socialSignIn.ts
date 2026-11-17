import * as AppleAuthentication from 'expo-apple-authentication';
import * as Application from 'expo-application';
import * as AuthSession from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import { Platform } from 'react-native';
import { ApiError, requestSocialNonce, type SocialCredential } from './auth';

function googleClientId(): string {
  const clientId = Platform.OS === 'ios'
    ? process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
    : Platform.OS === 'android'
      ? process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID
      : undefined;
  if (!clientId) {
    throw new ApiError(0, 'social_provider_not_configured', 'Google sign-in is not configured for this app.');
  }
  return clientId;
}

export async function beginGoogleSignIn(): Promise<SocialCredential | null> {
  const clientId = googleClientId();
  const nonce = await requestSocialNonce('google');
  const appScheme = Application.applicationId ?? 'com.greenfork.rewards';
  const redirectUri = AuthSession.makeRedirectUri({
    native: `${appScheme}:/oauthredirect`,
    scheme: appScheme,
    path: 'oauthredirect',
  });
  const scopes = ['openid', 'email', 'profile'];
  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri,
    responseType: AuthSession.ResponseType.Code,
    scopes,
    usePKCE: true,
    extraParams: { nonce },
  });
  const result = await request.promptAsync(Google.discovery);
  if (result.type === 'cancel' || result.type === 'dismiss') return null;
  if (result.type !== 'success') {
    throw new ApiError(0, 'google_sign_in_failed', 'Google sign-in could not be completed.');
  }
  const code = result.params.code;
  if (!code || !request.codeVerifier) {
    throw new ApiError(502, 'google_sign_in_failed', 'Google did not return a valid sign-in response.');
  }

  const tokenResponse = await AuthSession.exchangeCodeAsync({
    clientId,
    code,
    redirectUri,
    scopes,
    extraParams: { code_verifier: request.codeVerifier },
  }, Google.discovery);
  if (!tokenResponse.idToken) {
    throw new ApiError(502, 'google_sign_in_failed', 'Google did not return an identity token.');
  }
  return { provider: 'google', idToken: tokenResponse.idToken, nonce };
}

export async function beginAppleSignIn(): Promise<SocialCredential | null> {
  if (Platform.OS !== 'ios') {
    throw new ApiError(0, 'provider_unavailable', 'Apple sign-in is available on iOS only.');
  }
  if (!await AppleAuthentication.isAvailableAsync()) {
    throw new ApiError(0, 'provider_unavailable', 'Apple sign-in is not available on this device.');
  }

  const nonce = await requestSocialNonce('apple');
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      ],
      nonce,
      state: nonce,
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ERR_REQUEST_CANCELED'
    ) {
      return null;
    }
    throw error;
  }

  if (credential.state !== nonce) {
    throw new ApiError(401, 'invalid_social_credential', 'Apple could not verify this sign-in request.');
  }
  if (!credential.identityToken) {
    throw new ApiError(502, 'apple_sign_in_failed', 'Apple did not return an identity token.');
  }
  const name = [credential.fullName?.givenName, credential.fullName?.familyName]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .trim();
  return {
    provider: 'apple',
    idToken: credential.identityToken,
    nonce,
    ...(name ? { name } : {}),
  };
}
