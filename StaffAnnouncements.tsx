import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError } from './auth';
import { publishAnnouncement, type AnnouncementAudience } from './adminApi';
import { fetchEvents, type AppEvent } from './eventsApi';
import { useAppTheme } from './theme';

function eventKey(event: AppEvent): string {
  return `${event.id}:${event.occurrenceStart}`;
}

export default function StaffAnnouncements() {
  const { colors } = useAppTheme();
  const styles = useMemo(() => StyleSheet.create({
    panel: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 16, borderWidth: 1, gap: 12, padding: 16 },
    heading: { color: colors.text, fontSize: 18, fontWeight: '700' },
    label: { color: colors.brandAccent, fontSize: 13, fontWeight: '600' },
    muted: { color: colors.muted, fontSize: 13, lineHeight: 19 },
    input: { backgroundColor: colors.inputBackground, borderColor: colors.border, borderRadius: 10, borderWidth: 1, color: colors.text, minHeight: 46, padding: 12 },
    textArea: { minHeight: 110, textAlignVertical: 'top' },
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    choice: { backgroundColor: colors.subtleButton, borderColor: colors.border, borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9 },
    selectedChoice: { backgroundColor: colors.brand, borderColor: colors.brand },
    choiceText: { color: colors.subtleButtonText, fontSize: 13, fontWeight: '600' },
    selectedChoiceText: { color: colors.brandText },
    button: { alignItems: 'center', backgroundColor: colors.brand, borderRadius: 12, minHeight: 46, justifyContent: 'center', paddingHorizontal: 16 },
    buttonText: { color: colors.brandText, fontSize: 14, fontWeight: '700' },
    error: { color: colors.danger, fontSize: 14 },
    notice: { color: colors.brandAccent, fontSize: 14 },
  }), [colors]);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [audience, setAudience] = useState<'all' | 'event'>('all');
  const [selectedEventKey, setSelectedEventKey] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => Crypto.randomUUID());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    fetchEvents()
      .then(result => {
        if (active) {
          setEvents(result);
          setSelectedEventKey(result[0] ? eventKey(result[0]) : '');
        }
      })
      .catch(caught => {
        console.error('Unable to load events for announcement audiences.', caught);
        if (active) setError(caught instanceof ApiError ? caught.message : 'Unable to load events.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const selectedEvent = events.find(event => eventKey(event) === selectedEventKey);

  async function submit() {
    if (saving) return;
    if (title.trim().length === 0 || title.trim().length > 120) {
      setError('Enter an announcement title of up to 120 characters.');
      return;
    }
    if (body.trim().length === 0 || body.trim().length > 1000) {
      setError('Enter a message of up to 1,000 characters.');
      return;
    }
    let target: AnnouncementAudience;
    if (audience === 'all') {
      target = { type: 'all' };
    } else if (selectedEvent) {
      target = {
        type: 'event',
        eventId: selectedEvent.id,
        occurrenceStart: selectedEvent.occurrenceStart,
      };
    } else {
      setError('Choose an event occurrence for this announcement.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await publishAnnouncement(title.trim(), body.trim(), target, idempotencyKey);
      setNotice(result.alreadyApplied
        ? `This announcement was already published to ${result.recipients} recipient(s).`
        : `Announcement published to ${result.recipients} recipient(s).`);
      setTitle('');
      setBody('');
      setIdempotencyKey(Crypto.randomUUID());
    } catch (caught) {
      console.error('Unable to publish staff announcement.', caught);
      setError(caught instanceof ApiError ? caught.message : 'Unable to publish this announcement.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>New announcement</Text>
      <Text style={styles.muted}>Announcements appear in the in-app inbox and are pushed to opted-in devices.</Text>
      {error !== '' && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
      {notice !== '' && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
      <Text style={styles.label}>Audience</Text>
      <View style={styles.choices}>
        {([
          ['all', 'All members'],
          ['event', 'Event attendees'],
        ] as const).map(([value, label]) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            accessibilityState={{ selected: audience === value }}
            disabled={saving}
            onPress={() => { setAudience(value); setIdempotencyKey(Crypto.randomUUID()); }}
            style={[styles.choice, audience === value && styles.selectedChoice]}
          >
            <Text style={[styles.choiceText, audience === value && styles.selectedChoiceText]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {audience === 'event' && (loading
        ? <ActivityIndicator />
        : events.length === 0
          ? <Text style={styles.muted}>There are no upcoming event occurrences to target.</Text>
          : <View style={styles.choices}>
            {events.map(event => (
              <Pressable
                key={eventKey(event)}
                accessibilityRole="button"
                accessibilityState={{ selected: selectedEventKey === eventKey(event) }}
                disabled={saving}
                onPress={() => {
                  setSelectedEventKey(eventKey(event));
                  setIdempotencyKey(Crypto.randomUUID());
                }}
                style={[styles.choice, selectedEventKey === eventKey(event) && styles.selectedChoice]}
              >
                <Text style={[styles.choiceText, selectedEventKey === eventKey(event) && styles.selectedChoiceText]}>
                  {event.title} · {new Date(event.occurrenceStart).toLocaleString()}
                </Text>
              </Pressable>
            ))}
          </View>)}
      <Text style={styles.label}>Title</Text>
      <TextInput
        accessibilityLabel="Announcement title"
        editable={!saving}
        maxLength={120}
        onChangeText={value => { setTitle(value); setIdempotencyKey(Crypto.randomUUID()); }}
        style={styles.input}
        value={title}
      />
      <Text style={styles.label}>Message</Text>
      <TextInput
        accessibilityLabel="Announcement message"
        editable={!saving}
        maxLength={1000}
        multiline
        onChangeText={value => { setBody(value); setIdempotencyKey(Crypto.randomUUID()); }}
        style={[styles.input, styles.textArea]}
        value={body}
      />
      <Pressable accessibilityRole="button" disabled={saving} onPress={() => void submit()} style={styles.button}>
        {saving ? <ActivityIndicator color={colors.brandText} /> : <Text style={styles.buttonText}>Publish announcement</Text>}
      </Pressable>
    </View>
  );
}
