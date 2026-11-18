import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, Account } from './auth';
import EasternDateTimePicker from './EasternDateTimePicker';
import { easternDatePart, formatEasternDateTime } from './easternDateTime';
import {
  archiveEvent, archiveReward, assignRole, createEvent, createReward, fetchAttendees,
  fetchManagedEvents, fetchManagedRewards, fetchPointsSummary, fetchUserPoints, searchUsers,
  updateEvent, updateReward, type EventAttendee, type LedgerEntry, type ManagedEvent,
  type ManagedEventInput, type ManagedReward, type ManagedRewardInput, type PointsSummary,
  type StaffUser,
} from './adminApi';
import { fetchEvents, type AppEvent } from './eventsApi';

type Section = 'Users' | 'RSVPs' | 'Points' | 'Manage';
type EventDraft = Omit<ManagedEventInput, 'capacity' | 'recurrenceUntil'> & {
  capacity: string;
  recurrenceUntil: string;
};
type RewardDraft = ManagedRewardInput;

const emptyEvent: EventDraft = {
  title: '',
  startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  description: '',
  tag: '',
  capacity: '',
  rsvpOpen: true,
  bracketEnabled: false,
  recurrence: 'none',
  recurrenceUntil: '',
};

const emptyReward: RewardDraft = { name: '', pointsCost: 100, icon: '' };

function eventKey(event: AppEvent): string {
  return `${event.id}:${event.occurrenceStart}`;
}

export default function StaffDashboard({ account }: { account: Account }) {
  const isAdmin = account.role === 'admin';
  const sections: Section[] = isAdmin ? ['Users', 'RSVPs', 'Points', 'Manage'] : ['Users', 'RSVPs', 'Points'];
  const [section, setSection] = useState<Section>('Users');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userPageSize, setUserPageSize] = useState(50);
  const [ledgerUser, setLedgerUser] = useState<StaffUser | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [summary, setSummary] = useState<PointsSummary | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [selectedEventKey, setSelectedEventKey] = useState('');
  const [attendees, setAttendees] = useState<EventAttendee[]>([]);
  const [attendeeTotal, setAttendeeTotal] = useState(0);
  const [managedEvents, setManagedEvents] = useState<ManagedEvent[]>([]);
  const [managedRewards, setManagedRewards] = useState<ManagedReward[]>([]);
  const [editingEventId, setEditingEventId] = useState('');
  const [eventDraft, setEventDraft] = useState<EventDraft>(emptyEvent);
  const [editingRewardId, setEditingRewardId] = useState('');
  const [rewardDraft, setRewardDraft] = useState<RewardDraft>(emptyReward);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selectedEvent = events.find(event => eventKey(event) === selectedEventKey);

  useEffect(() => {
    let active = true;
    fetchPointsSummary()
      .then(result => { if (active) setSummary(result); })
      .catch(caught => { if (active) showError(caught, 'Unable to load the points summary.'); })
      .finally(() => { if (active) setPending(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (section !== 'RSVPs') return;
    let active = true;
    fetchEvents()
      .then(result => {
        if (active) {
          setEvents(result);
          setSelectedEventKey(current => current || (result[0] ? eventKey(result[0]) : ''));
        }
      })
      .catch(caught => { if (active) showError(caught, 'Unable to load events.'); });
    return () => { active = false; };
  }, [section]);

  useEffect(() => {
    const selectedEvent = events.find(event => eventKey(event) === selectedEventKey);
    if (!selectedEvent || section !== 'RSVPs') return;
    let active = true;
    fetchAttendees(selectedEvent.id, selectedEvent.occurrenceStart)
      .then(result => {
        if (active) {
          setAttendees(result.attendees);
          setAttendeeTotal(result.total);
        }
      })
      .catch(caught => { if (active) showError(caught, 'Unable to load RSVP attendees.'); });
    return () => { active = false; };
  }, [selectedEventKey, section, events]);

  useEffect(() => {
    if (section !== 'Manage' || !isAdmin) return;
    let active = true;
    Promise.all([fetchManagedEvents(), fetchManagedRewards()])
      .then(([eventResult, rewardResult]) => {
        if (active) {
          setManagedEvents(eventResult);
          setManagedRewards(rewardResult);
        }
      })
      .catch(caught => { if (active) showError(caught, 'Unable to load management data.'); });
    return () => { active = false; };
  }, [section, isAdmin]);

  function showError(caught: unknown, fallback: string) {
    console.error(fallback, caught);
    setError(caught instanceof ApiError ? caught.message : fallback);
  }

  async function runAction(action: () => Promise<void>, successMessage: string) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(successMessage);
    } catch (caught) {
      showError(caught, 'The request could not be completed.');
    } finally {
      setPending(false);
    }
  }

  async function runSearch(page = 1) {
    if (query.trim().length < 2) {
      setError('Enter at least two characters to search.');
      return;
    }
    setPending(true);
    setError('');
    setLedgerUser(null);
    setLedger([]);
    try {
      const result = await searchUsers(query.trim(), page);
      setUsers(result.users);
      setUserTotal(result.total);
      setUserPage(result.page);
      setUserPageSize(result.pageSize);
    } catch (caught) {
      showError(caught, 'Unable to search users.');
    } finally {
      setPending(false);
    }
  }

  async function showLedger(user: StaffUser) {
    setPending(true);
    setError('');
    try {
      const result = await fetchUserPoints(user.id);
      setLedgerUser(user);
      setLedger(result.entries);
    } catch (caught) {
      showError(caught, 'Unable to load this points ledger.');
    } finally {
      setPending(false);
    }
  }

  async function changeUserRole(user: StaffUser, role: StaffUser['role']) {
    await runAction(async () => {
      await assignRole(user.id, role);
      const result = await searchUsers(query.trim(), userPage);
      setUsers(result.users);
      setUserTotal(result.total);
      setUserPage(result.page);
      setUserPageSize(result.pageSize);
    }, `${user.name}'s role was updated.`);
  }

  async function saveEvent() {
    if (!Number.isFinite(new Date(eventDraft.startsAt).getTime())) {
      setError('Choose a valid event start date and time.');
      return;
    }
    if (eventDraft.recurrence !== 'none' && eventDraft.recurrenceUntil !== '' &&
      eventDraft.recurrenceUntil < easternDatePart(eventDraft.startsAt)) {
      setError('The recurrence end date must be on or after the event date.');
      return;
    }
    const capacity = eventDraft.capacity.trim() === '' ? null : Number(eventDraft.capacity);
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) {
      setError('Capacity must be a positive whole number, or blank for unlimited.');
      return;
    }
    const input: ManagedEventInput = {
      ...eventDraft,
      capacity,
      recurrenceUntil: eventDraft.recurrence === 'none' || eventDraft.recurrenceUntil === ''
        ? null
        : eventDraft.recurrenceUntil,
    };
    await runAction(async () => {
      if (editingEventId) await updateEvent(editingEventId, input);
      else await createEvent(input);
      setManagedEvents(await fetchManagedEvents());
      setEditingEventId('');
      setEventDraft(emptyEvent);
    }, editingEventId ? 'Event updated.' : 'Event created.');
  }

  function editEvent(event: ManagedEvent) {
    setEditingEventId(event.id);
    setEventDraft({
      title: event.title,
      startsAt: event.startsAt,
      description: event.description,
      tag: event.tag,
      capacity: event.capacity === null ? '' : String(event.capacity),
      rsvpOpen: event.rsvpOpen,
      bracketEnabled: event.bracketEnabled,
      recurrence: event.recurrence,
      recurrenceUntil: event.recurrenceUntil ?? '',
    });
  }

  async function removeEvent(event: ManagedEvent) {
    await runAction(async () => {
      await archiveEvent(event.id);
      setManagedEvents(await fetchManagedEvents());
      if (editingEventId === event.id) {
        setEditingEventId('');
        setEventDraft(emptyEvent);
      }
    }, 'Event archived.');
  }

  async function saveReward() {
    if (!Number.isInteger(rewardDraft.pointsCost) || rewardDraft.pointsCost < 1) {
      setError('Reward cost must be a positive whole number.');
      return;
    }
    await runAction(async () => {
      if (editingRewardId) await updateReward(editingRewardId, rewardDraft);
      else await createReward(rewardDraft);
      setManagedRewards(await fetchManagedRewards());
      setEditingRewardId('');
      setRewardDraft(emptyReward);
    }, editingRewardId ? 'Reward updated.' : 'Reward created.');
  }

  function editReward(reward: ManagedReward) {
    setEditingRewardId(reward.id);
    setRewardDraft({
      name: reward.name,
      pointsCost: reward.pointsCost,
      icon: reward.icon,
    });
  }

  async function removeReward(reward: ManagedReward) {
    await runAction(async () => {
      await archiveReward(reward.id);
      setManagedRewards(await fetchManagedRewards());
      if (editingRewardId === reward.id) {
        setEditingRewardId('');
        setRewardDraft(emptyReward);
      }
    }, 'Reward archived.');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Staff workspace</Text>
      <Text style={styles.muted}>Signed in as {account.role}. Staff reports are read-only.</Text>
      <View style={styles.sectionBar}>
        {sections.map(item => (
          <Pressable
            key={item}
            accessibilityRole="button"
            accessibilityState={{ selected: section === item }}
            onPress={() => { setSection(item); setError(''); setNotice(''); }}
            style={[styles.sectionButton, section === item && styles.sectionButtonActive]}
          >
            <Text style={[styles.sectionButtonText, section === item && styles.sectionButtonTextActive]}>{item}</Text>
          </Pressable>
        ))}
      </View>
      {error !== '' && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
      {notice !== '' && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
      {pending && <ActivityIndicator color="#234D38" />}

      {section === 'Users' && (
        <View style={styles.panel}>
          <Text style={styles.subheading}>Find a member</Text>
          <TextInput
            accessibilityLabel="Search users by name or email"
            autoCapitalize="none"
            onChangeText={setQuery}
            onSubmitEditing={() => void runSearch(1)}
            placeholder="Name or email"
            style={styles.input}
            value={query}
          />
          <ActionButton label="Search users" disabled={pending} onPress={() => void runSearch(1)} />
          <Text style={styles.muted}>
            Showing {userTotal === 0 ? 0 : (userPage - 1) * userPageSize + 1}–{Math.min(userPage * userPageSize, userTotal)} of {userTotal} matching account(s); balances are read from the points ledger.
          </Text>
          {users.length > 0 && (
            <View style={styles.inlineActions}>
              <ActionButton label="Previous" disabled={pending || userPage <= 1} onPress={() => void runSearch(userPage - 1)} />
              <Text style={styles.detail}>Page {userPage} of {Math.max(1, Math.ceil(userTotal / userPageSize))}</Text>
              <ActionButton
                label="Next"
                disabled={pending || userPage * userPageSize >= userTotal}
                onPress={() => void runSearch(userPage + 1)}
              />
            </View>
          )}
          {users.map(user => (
            <View key={user.id} style={styles.card}>
              <Text style={styles.cardTitle}>{user.name}</Text>
              <Text style={styles.muted}>{user.email}</Text>
              <Text style={styles.detail}>Role: {user.role} · {user.emailVerifiedAt ? 'Verified' : 'Unverified'} · {user.rewardPoints} points</Text>
              <ActionButton label="View points ledger" disabled={pending} onPress={() => void showLedger(user)} />
              {isAdmin && (
                <View style={styles.inlineActions}>
                  {(['member', 'staff', 'admin'] as const).map(role => (
                    <ActionButton
                      key={role}
                      label={`Set ${role}`}
                      disabled={pending || user.id === account.id || user.role === role}
                      onPress={() => void changeUserRole(user, role)}
                    />
                  ))}
                </View>
              )}
            </View>
          ))}
          {ledgerUser && (
            <View style={styles.panel}>
              <Text style={styles.subheading}>{ledgerUser.name} · {ledgerUser.rewardPoints} points</Text>
              {ledger.length === 0 && <Text style={styles.muted}>No points ledger entries.</Text>}
              {ledger.map(entry => (
                <Text key={entry.id} style={styles.detail}>
                  {entry.delta > 0 ? '+' : ''}{entry.delta} · {entry.entryType} · {new Date(entry.createdAt).toLocaleString()}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}

      {section === 'Points' && (
        <View style={styles.panel}>
          <Text style={styles.subheading}>Program points</Text>
          {summary ? (
            <>
              <Metric label="Total members" value={summary.totalUsers} />
              <Metric label="Members with points" value={summary.usersWithPoints} />
              <Metric label="Points across all accounts" value={summary.totalPoints} />
            </>
          ) : <Text style={styles.muted}>Loading points totals…</Text>}
          <Text style={styles.muted}>Balances are ledger-derived. This release does not allow staff to adjust points.</Text>
        </View>
      )}

      {section === 'RSVPs' && (
        <View style={styles.panel}>
          <Text style={styles.subheading}>Event attendees</Text>
          {events.map(event => (
            <ActionButton
              key={eventKey(event)}
              label={`${event.title} · ${formatEasternDateTime(event.occurrenceStart)} · ${event.attendeeCount} RSVP(s)`}
              disabled={pending}
              selected={selectedEventKey === eventKey(event)}
              onPress={() => setSelectedEventKey(eventKey(event))}
            />
          ))}
          {selectedEvent && <Text style={styles.muted}>
            {formatEasternDateTime(selectedEvent.occurrenceStart)} · {attendeeTotal} attendee(s); only names and RSVP times are shown.
          </Text>}
          {attendees.map(attendee => (
            <View key={attendee.userId} style={styles.attendee}>
              <Text style={styles.detail}>{attendee.name}</Text>
              <Text style={styles.muted}>{formatEasternDateTime(attendee.rsvpAt)}</Text>
            </View>
          ))}
          {selectedEvent && attendees.length === 0 && <Text style={styles.muted}>No RSVPs yet.</Text>}
        </View>
      )}

      {section === 'Manage' && isAdmin && (
        <>
          <View style={styles.panel}>
            <Text style={styles.subheading}>{editingEventId ? 'Edit event' : 'Create event'}</Text>
            <Field label="Title" value={eventDraft.title} onChangeText={title => setEventDraft(current => ({ ...current, title }))} />
            <EasternDateTimePicker
              label="Starts at"
              value={eventDraft.startsAt}
              onChange={startsAt => setEventDraft(current => ({ ...current, startsAt }))}
            />
            <Field label="Description" value={eventDraft.description} multiline onChangeText={description => setEventDraft(current => ({ ...current, description }))} />
            <Field label="Tag" value={eventDraft.tag} onChangeText={tag => setEventDraft(current => ({ ...current, tag }))} />
            <Field label="Capacity (blank for unlimited)" value={eventDraft.capacity} keyboardType="numeric" onChangeText={capacity => setEventDraft(current => ({ ...current, capacity }))} />
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>Repeats</Text>
              <View style={styles.inlineActions}>
                {([
                  ['none', 'Never'],
                  ['weekly', 'Weekly'],
                  ['monthly', 'Monthly'],
                ] as const).map(([value, label]) => (
                  <ActionButton
                    key={value}
                    label={label}
                    selected={eventDraft.recurrence === value}
                    onPress={() => setEventDraft(current => ({
                      ...current,
                      recurrence: value,
                      recurrenceUntil: value === 'none' ? '' : current.recurrenceUntil,
                    }))}
                  />
                ))}
              </View>
              {eventDraft.recurrence !== 'none' && (
                <>
                  <Text style={styles.muted}>Each date has its own RSVP. Leave the end date blank to repeat until archived.</Text>
                  <EasternDateTimePicker
                    label="Repeat through (optional)"
                    mode="date"
                    value={eventDraft.recurrenceUntil}
                    onChange={recurrenceUntil => setEventDraft(current => ({ ...current, recurrenceUntil }))}
                  />
                </>
              )}
            </View>
            <ActionButton
              label={`Tournament bracket ${eventDraft.bracketEnabled ? 'enabled' : 'disabled'} · Toggle`}
              selected={eventDraft.bracketEnabled}
              onPress={() => setEventDraft(current => ({ ...current, bracketEnabled: !current.bracketEnabled }))}
            />
            {eventDraft.bracketEnabled ? (
              <Text style={styles.muted}>
                RSVPs and guest entries close automatically at each occurrence’s start. The RSVP toggle does not apply to bracket events.
              </Text>
            ) : (
              <ActionButton
                label={`RSVPs ${eventDraft.rsvpOpen ? 'open' : 'closed'} · Toggle`}
                onPress={() => setEventDraft(current => ({ ...current, rsvpOpen: !current.rsvpOpen }))}
              />
            )}
            <ActionButton label={editingEventId ? 'Save event' : 'Create event'} disabled={pending} onPress={() => void saveEvent()} />
            {editingEventId !== '' && <ActionButton label="Cancel edit" onPress={() => { setEditingEventId(''); setEventDraft(emptyEvent); }} />}
          </View>
          <View style={styles.panel}>
            <Text style={styles.subheading}>Manage events</Text>
            {managedEvents.map(event => (
              <View key={event.id} style={styles.card}>
                <Text style={styles.cardTitle}>{event.title}</Text>
                <Text style={styles.muted}>
                  {event.active ? 'Active' : 'Archived'} · {event.rsvpOpen ? 'RSVPs open' : 'RSVPs closed'}
                  {' · '}{event.bracketEnabled ? 'Bracket enabled' : 'Bracket disabled'}
                  {' · '}{event.recurrence === 'none' ? 'One-time' : `Repeats ${event.recurrence}`}
                  {' · '}{formatEasternDateTime(event.startsAt)}
                  {event.recurrenceUntil ? ` · Through ${event.recurrenceUntil}` : ''}
                </Text>
                {event.active && (
                  <View style={styles.inlineActions}>
                    <ActionButton label="Edit" disabled={pending} onPress={() => editEvent(event)} />
                    <ActionButton label="Archive" disabled={pending} onPress={() => void removeEvent(event)} />
                  </View>
                )}
              </View>
            ))}
          </View>
          <View style={styles.panel}>
            <Text style={styles.subheading}>{editingRewardId ? 'Edit reward' : 'Create reward'}</Text>
            <Field label="Reward name" value={rewardDraft.name} onChangeText={name => setRewardDraft(current => ({ ...current, name }))} />
            <Field label="Point cost" value={String(rewardDraft.pointsCost)} keyboardType="numeric" onChangeText={value => setRewardDraft(current => ({ ...current, pointsCost: Number(value) }))} />
            <Field label="Icon" value={rewardDraft.icon} onChangeText={icon => setRewardDraft(current => ({ ...current, icon }))} />
            <ActionButton label={editingRewardId ? 'Save reward' : 'Create reward'} disabled={pending} onPress={() => void saveReward()} />
            {editingRewardId !== '' && <ActionButton label="Cancel edit" onPress={() => { setEditingRewardId(''); setRewardDraft(emptyReward); }} />}
          </View>
          <View style={styles.panel}>
            <Text style={styles.subheading}>Manage rewards</Text>
            {managedRewards.map(reward => (
              <View key={reward.id} style={styles.card}>
                <Text style={styles.cardTitle}>{reward.icon} {reward.name} · {reward.pointsCost} points</Text>
                <Text style={styles.muted}>{reward.active ? 'Active' : 'Archived'}</Text>
                {reward.active && (
                  <View style={styles.inlineActions}>
                    <ActionButton label="Edit" disabled={pending} onPress={() => editReward(reward)} />
                    <ActionButton label="Archive" disabled={pending} onPress={() => void removeReward(reward)} />
                  </View>
                )}
              </View>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

function Field({
  label,
  value,
  placeholder,
  disabled,
  multiline,
  keyboardType,
  onChangeText,
}: {
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  multiline?: boolean;
  keyboardType?: 'default' | 'numeric';
  onChangeText: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        editable={!disabled}
        keyboardType={keyboardType ?? 'default'}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        style={[styles.input, multiline && styles.multiline, disabled && styles.disabledInput]}
        value={value}
      />
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  disabled = false,
  selected = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.actionButton, selected && styles.selectedButton, disabled && styles.disabledButton]}
    >
      <Text style={[styles.actionButtonText, selected && styles.selectedButtonText]}>{label}</Text>
    </Pressable>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value.toLocaleString()}</Text>
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 14 },
  heading: { color: '#233B2B', fontSize: 24, fontWeight: '700' },
  subheading: { color: '#234D38', fontSize: 18, fontWeight: '700' },
  muted: { color: '#657064', fontSize: 13, lineHeight: 19 },
  detail: { color: '#233B2B', fontSize: 14, lineHeight: 20 },
  error: { color: '#A12A24', fontSize: 13, lineHeight: 19 },
  notice: { color: '#234D38', fontSize: 13, lineHeight: 19 },
  sectionBar: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sectionButton: { backgroundColor: '#E9EEDD', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9 },
  sectionButtonActive: { backgroundColor: '#234D38' },
  sectionButtonText: { color: '#426046', fontWeight: '600' },
  sectionButtonTextActive: { color: '#FFF' },
  panel: { backgroundColor: '#FFF', borderColor: '#E5E7DD', borderRadius: 16, borderWidth: 1, gap: 12, padding: 16 },
  card: { backgroundColor: '#FAF9F5', borderColor: '#E5E7DD', borderRadius: 12, borderWidth: 1, gap: 8, padding: 12 },
  cardTitle: { color: '#233B2B', fontSize: 15, fontWeight: '700' },
  input: { backgroundColor: '#FAF9F5', borderColor: '#DDE2D6', borderRadius: 10, borderWidth: 1, color: '#233B2B', minHeight: 44, paddingHorizontal: 12, paddingVertical: 9 },
  multiline: { minHeight: 76, textAlignVertical: 'top' },
  disabledInput: { opacity: 0.6 },
  field: { gap: 5 },
  fieldLabel: { color: '#426046', fontSize: 12, fontWeight: '600' },
  actionButton: { alignItems: 'center', backgroundColor: '#E9EEDD', borderRadius: 10, justifyContent: 'center', minHeight: 40, paddingHorizontal: 12, paddingVertical: 8 },
  actionButtonText: { color: '#234D38', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  selectedButton: { backgroundColor: '#234D38' },
  selectedButtonText: { color: '#FFF' },
  disabledButton: { opacity: 0.5 },
  inlineActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  attendee: { borderBottomColor: '#E5E7DD', borderBottomWidth: 1, gap: 2, paddingVertical: 8 },
  metric: { backgroundColor: '#FAF9F5', borderRadius: 12, gap: 3, padding: 12 },
  metricValue: { color: '#234D38', fontSize: 22, fontWeight: '700' },
});
