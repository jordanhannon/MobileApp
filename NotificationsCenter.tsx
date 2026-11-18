import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError } from './auth';
import {
  fetchNotificationPreferences, fetchNotifications, markAllNotificationsRead,
  markNotificationRead, requestPushRegistration, saveNotificationPreferences,
  revokeRegisteredPushToken, syncGrantedPushToken, type NotificationItem, type NotificationPreferences,
} from './notificationsApi';
import { useAppTheme } from './theme';

type AppTab = 'Events' | 'Rewards';

function useNotificationStyles() {
  const { colors } = useAppTheme();
  return useMemo(() => StyleSheet.create({
    panel: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 18,
      borderWidth: 1,
      gap: 12,
      marginBottom: 16,
      padding: 18,
    },
    row: {
      alignItems: 'center',
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'space-between',
      paddingVertical: 11,
    },
    rowText: { color: colors.text, flex: 1, fontSize: 15, fontWeight: '600' },
    title: { color: colors.text, fontSize: 17, fontWeight: '700' },
    body: { color: colors.muted, fontSize: 14, lineHeight: 20 },
    error: { color: colors.danger, fontSize: 14 },
    notice: { color: colors.brandAccent, fontSize: 14 },
    muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
    action: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      backgroundColor: colors.subtleButton,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      minHeight: 40,
      justifyContent: 'center',
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    actionText: { color: colors.subtleButtonText, fontSize: 14, fontWeight: '700' },
    selected: { backgroundColor: colors.brand, borderColor: colors.brand },
    selectedText: { color: colors.brandText },
    notification: {
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      gap: 6,
      padding: 14,
    },
    unread: { borderColor: colors.brand, borderWidth: 2 },
    pagination: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  }), [colors]);
}

function messageFor(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function NotificationsInbox({
  onNavigate,
  onUnreadCountChange,
}: {
  onNavigate: (tab: AppTab, data: Record<string, string>) => void;
  onUnreadCountChange?: (count: number) => void;
}) {
  const styles = useNotificationStyles();
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
  }, [onUnreadCountChange, unreadCount]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchNotifications(page)
      .then(result => {
        if (!active) return;
        setItems(result.items);
        setTotal(result.total);
        setUnreadCount(result.unreadCount);
        setError('');
      })
      .catch(caught => {
        console.error('Unable to load notifications.', caught);
        if (active) setError(messageFor(caught, 'We could not load notifications. Please try again.'));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page]);

  async function markRead(item: NotificationItem) {
    if (item.readAt) {
      if (item.data.screen === 'Events' || item.data.screen === 'Rewards') onNavigate(item.data.screen, item.data);
      return;
    }
    try {
      await markNotificationRead(item.id);
      const readAt = new Date().toISOString();
      setItems(current => current.map(notification =>
        notification.id === item.id ? { ...notification, readAt } : notification));
      const nextUnreadCount = Math.max(0, unreadCount - 1);
      setUnreadCount(nextUnreadCount);
      onUnreadCountChange?.(nextUnreadCount);
      if (item.data.screen === 'Events' || item.data.screen === 'Rewards') onNavigate(item.data.screen, item.data);
    } catch (caught) {
      console.error('Unable to mark the notification as read.', caught);
      setError(messageFor(caught, 'We could not update this notification.'));
    }
  }

  async function markAllRead() {
    try {
      await markAllNotificationsRead();
      const readAt = new Date().toISOString();
      setItems(current => current.map(item => ({ ...item, readAt: item.readAt ?? readAt })));
      setUnreadCount(0);
      setError('');
    } catch (caught) {
      console.error('Unable to mark notifications as read.', caught);
      setError(messageFor(caught, 'We could not update your notifications.'));
    }
  }

  return (
    <View style={styles.panel}>
      <View style={styles.pagination}>
        <Text style={styles.title}>Inbox{unreadCount > 0 ? ` · ${unreadCount} unread` : ''}</Text>
        {unreadCount > 0 && (
          <Pressable accessibilityRole="button" onPress={() => void markAllRead()} style={styles.action}>
            <Text style={styles.actionText}>Mark all read</Text>
          </Pressable>
        )}
      </View>
      {error !== '' && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
      {loading && <ActivityIndicator />}
      {!loading && error === '' && items.length === 0 && <Text style={styles.muted}>You’re all caught up. New updates will appear here.</Text>}
      {!loading && items.map(item => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={`${item.readAt ? '' : 'Unread. '}${item.title}. ${item.body}`}
          onPress={() => void markRead(item)}
          style={[styles.notification, item.readAt === null && styles.unread]}
        >
          <Text style={styles.title}>{item.title}</Text>
          <Text style={styles.body}>{item.body}</Text>
          <Text style={styles.muted}>{new Date(item.createdAt).toLocaleString()}</Text>
        </Pressable>
      ))}
      {!loading && pageCount > 1 && (
        <View style={styles.pagination}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: page <= 1 }}
            disabled={page <= 1}
            onPress={() => setPage(current => Math.max(1, current - 1))}
            style={styles.action}
          >
            <Text style={styles.actionText}>Previous</Text>
          </Pressable>
          <Text style={styles.muted}>Page {page} of {pageCount}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: page >= pageCount }}
            disabled={page >= pageCount}
            onPress={() => setPage(current => Math.min(pageCount, current + 1))}
            style={styles.action}
          >
            <Text style={styles.actionText}>Next</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

export function NotificationSettings() {
  const styles = useNotificationStyles();
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    fetchNotificationPreferences()
      .then(async result => {
        if (!active) return;
        setPreferences(result);
        if (result.pushEnabled) {
          try {
            await syncGrantedPushToken();
          } catch (caught) {
            console.error('Unable to synchronize this device push token.', caught);
            if (active) setNotice('Push registration could not be refreshed. You can try enabling push again below.');
          }
        }
      })
      .catch(caught => {
        console.error('Unable to load notification preferences.', caught);
        if (active) setError(messageFor(caught, 'We could not load notification preferences.'));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save(next: NotificationPreferences) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const saved = await saveNotificationPreferences(next);
      setPreferences(saved);
      return saved;
    } catch (caught) {
      console.error('Unable to save notification preferences.', caught);
      setError(messageFor(caught, 'We could not save your notification preferences.'));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function toggle(key: keyof Omit<NotificationPreferences, 'reminderSchedule'>) {
    if (!preferences || saving) return;
    const saved = await save({ ...preferences, [key]: !preferences[key] });
    if (saved && key === 'pushEnabled' && saved.pushEnabled) {
      await enablePush();
    } else if (saved && key === 'pushEnabled' && !saved.pushEnabled) {
      try {
        await revokeRegisteredPushToken();
      } catch (caught) {
        console.error('Push was disabled but this device token could not be revoked.', caught);
        setError(messageFor(caught, 'Push is disabled, but this device could not be disconnected.'));
      }
    }
  }

  async function updateReminder(reminderSchedule: NotificationPreferences['reminderSchedule']) {
    if (!preferences || saving) return;
    await save({ ...preferences, reminderSchedule });
  }

  async function enablePush() {
    try {
      const result = await requestPushRegistration();
      if (result === 'denied') {
        setNotice('Device permission is off. You can still read updates in the inbox; enable notifications in your device settings to receive push.');
      } else if (result === 'unsupported') {
        setNotice('Push delivery is available in the iOS and Android apps. Your in-app inbox works here.');
      } else {
        setNotice('Push notifications are enabled on this device.');
      }
    } catch (caught) {
      console.error('Unable to enable push notifications.', caught);
      setError(messageFor(caught, 'Push setup failed. Please try again.'));
    }
  }

  if (loading) return <ActivityIndicator />;
  if (!preferences) return error !== '' ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null;

  const categories: Array<[keyof Omit<NotificationPreferences, 'pushEnabled' | 'reminderSchedule'>, string]> = [
    ['rsvpUpdatesEnabled', 'RSVP updates and reminders'],
    ['eventChangesEnabled', 'Event changes and cancellations'],
    ['rewardsEnabled', 'Rewards and points'],
    ['announcementsEnabled', 'Staff announcements'],
  ];
  const reminderOptions: Array<[NotificationPreferences['reminderSchedule'], string]> = [
    ['off', 'Off'],
    ['24h', '24 hours'],
    ['1h', '1 hour'],
    ['24h_1h', '24 hours + 1 hour'],
  ];

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Notification preferences</Text>
      <Text style={styles.muted}>Choose which updates appear in your inbox. Push requires permission on each device.</Text>
      {error !== '' && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
      {notice !== '' && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
      {categories.map(([key, label]) => (
        <Pressable
          key={key}
          accessibilityRole="switch"
          accessibilityState={{ checked: preferences[key], disabled: saving }}
          disabled={saving}
          onPress={() => void toggle(key)}
          style={styles.row}
        >
          <Text style={styles.rowText}>{label}</Text>
          <Text style={styles.actionText}>{preferences[key] ? 'On' : 'Off'}</Text>
        </Pressable>
      ))}
      <Text style={styles.rowText}>RSVP reminder timing</Text>
      <View style={styles.actions}>
        {reminderOptions.map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected: preferences.reminderSchedule === value, disabled: saving }}
            disabled={saving}
            onPress={() => void updateReminder(value)}
            style={[styles.action, preferences.reminderSchedule === value && styles.selected]}
          >
            <Text style={[styles.actionText, preferences.reminderSchedule === value && styles.selectedText]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: preferences.pushEnabled, disabled: saving }}
        disabled={saving}
        onPress={() => void toggle('pushEnabled')}
        style={styles.row}
      >
        <Text style={styles.rowText}>Push delivery</Text>
        <Text style={styles.actionText}>{preferences.pushEnabled ? 'On' : 'Off'}</Text>
      </Pressable>
      {preferences.pushEnabled && (
        <Pressable accessibilityRole="button" disabled={saving} onPress={() => void enablePush()} style={styles.action}>
          <Text style={styles.actionText}>Enable push on this device</Text>
        </Pressable>
      )}
      {saving && <ActivityIndicator />}
    </View>
  );
}
