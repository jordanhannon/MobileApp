import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { apiRequest } from './auth';

export type NotificationItem = {
  id: string;
  type: 'rsvp_confirmed' | 'rsvp_cancelled' | 'event_reminder' | 'event_changed' |
    'event_cancelled' | 'points_earned' | 'reward_redeemed' | 'announcement';
  title: string;
  body: string;
  data: Record<string, string>;
  createdAt: string;
  readAt: string | null;
};

export type NotificationPage = {
  items: NotificationItem[];
  total: number;
  unreadCount: number;
  page: number;
  pageSize: number;
};

export type NotificationPreferences = {
  rsvpUpdatesEnabled: boolean;
  eventChangesEnabled: boolean;
  rewardsEnabled: boolean;
  announcementsEnabled: boolean;
  pushEnabled: boolean;
  reminderSchedule: 'off' | '24h' | '1h' | '24h_1h';
};

const PUSH_TOKEN_KEY = 'green-fork-expo-push-token';

export async function fetchNotifications(page = 1): Promise<NotificationPage> {
  return apiRequest(`/notifications?page=${page}&pageSize=20`);
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  await apiRequest(`/notifications/${encodeURIComponent(notificationId)}/read`, { method: 'POST', body: {} });
}

export async function markAllNotificationsRead(): Promise<number> {
  const result = await apiRequest<{ updated: number }>('/notifications/read-all', { method: 'POST', body: {} });
  return result.updated;
}

export async function fetchNotificationPreferences(): Promise<NotificationPreferences> {
  const result = await apiRequest<{ preferences: NotificationPreferences }>('/notifications/preferences');
  return result.preferences;
}

export async function saveNotificationPreferences(
  preferences: NotificationPreferences,
): Promise<NotificationPreferences> {
  const result = await apiRequest<{ preferences: NotificationPreferences }>(
    '/notifications/preferences',
    { method: 'POST', body: preferences },
  );
  return result.preferences;
}

export async function requestPushRegistration(): Promise<'registered' | 'denied' | 'unsupported'> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return 'unsupported';
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'General',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted || current.status === 'granted'
    ? current
    : current.canAskAgain
      ? await Notifications.requestPermissionsAsync()
      : current;
  if (!permission.granted && permission.status !== 'granted') return 'denied';

  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  const expoToken = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  const token = expoToken.data;
  await apiRequest('/notifications/push-token', {
    method: 'POST',
    body: { token, platform: Platform.OS },
  });
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
  return 'registered';
}

export async function syncGrantedPushToken(): Promise<void> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted && permission.status !== 'granted') return;
  await requestPushRegistration();
}

export async function revokeRegisteredPushToken(): Promise<void> {
  if (Platform.OS === 'web') return;
  const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  if (!token) return;
  await apiRequest('/notifications/push-token', {
    method: 'DELETE',
    body: { token },
  });
  await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
}
