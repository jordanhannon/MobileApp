import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View,
} from 'react-native';
import { Account, ApiError } from './auth';
import {
  addBracketGuest, fetchBracketGuests, fetchEventBracket, recordBracketWinner, removeBracketGuest,
  type BracketGuest, type TournamentBracket,
} from './bracketApi';
import { fetchEvents, type AppEvent } from './eventsApi';
import { formatEasternDateTime } from './easternDateTime';
import { useAppTheme } from './theme';

function roundTitle(round: number, total: number): string {
  if (round === total) return 'Final';
  if (round === total - 1) return 'Semifinals';
  if (round === total - 2) return 'Quarterfinals';
  return `Round ${round}`;
}

function cutoffCountdown(cutoffAt: string, now: number): string {
  const remaining = new Date(cutoffAt).getTime() - now;
  if (remaining <= 0) return 'RSVPs are closed. The randomized draw will appear shortly.';
  const minutes = Math.ceil(remaining / 60_000);
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const remainingMinutes = minutes % 60;
  const parts = [
    days > 0 ? `${days}d` : '',
    hours > 0 ? `${hours}h` : '',
    `${remainingMinutes}m`,
  ].filter(Boolean);
  return `RSVPs close in ${parts.join(' ')}.`;
}

const MATCH_WIDTH = 184;
const MATCH_HEIGHT = 80;
const ROUND_GAP = 32;
const ROUND_STRIDE = MATCH_WIDTH + ROUND_GAP;
const SLOT_HEIGHT = 116;
const HEADER_HEIGHT = 36;
const FINAL_PLAYER_OFFSET = MATCH_HEIGHT / 4;

type MatchPlacement = { x: number; centerY: number };

function isByeMatch(match: TournamentBracket['rounds'][number][number], roundIndex: number): boolean {
  return roundIndex === 0 && Boolean(match.playerOne) !== Boolean(match.playerTwo);
}

function getMatchPlacements(rounds: TournamentBracket['rounds'], singleSided: boolean): {
  placements: Map<string, MatchPlacement>;
  width: number;
  height: number;
  finalRoundIndex: number;
} {
  const finalRoundIndex = rounds.length - 1;
  const width = finalRoundIndex * (singleSided ? ROUND_STRIDE : 2 * ROUND_STRIDE) + MATCH_WIDTH;
  const centers = new Map<string, number>();
  const finalMatch = rounds[finalRoundIndex][0];
  centers.set(finalMatch.id, 0);

  for (let roundIndex = finalRoundIndex - 1; roundIndex >= 0; roundIndex -= 1) {
    const children = rounds[roundIndex];
    const parents = rounds[roundIndex + 1];
    const childOffset = SLOT_HEIGHT * (2 ** (roundIndex - 1));
    parents.forEach((parent, parentIndex) => {
      const parentCenter = centers.get(parent.id);
      if (parentCenter === undefined) return;
      const first = children[parentIndex * 2];
      const second = children[parentIndex * 2 + 1];
      const firstIsVisible = !isByeMatch(first, roundIndex);
      const secondIsVisible = !isByeMatch(second, roundIndex);
      if (firstIsVisible && secondIsVisible) {
        centers.set(first.id, parentCenter - childOffset);
        centers.set(second.id, parentCenter + childOffset);
      } else if (firstIsVisible) {
        centers.set(first.id, parentCenter);
      } else if (secondIsVisible) {
        centers.set(second.id, parentCenter);
      }
    });
  }

  let minCenter = Number.POSITIVE_INFINITY;
  let maxCenter = Number.NEGATIVE_INFINITY;
  centers.forEach(center => {
    minCenter = Math.min(minCenter, center);
    maxCenter = Math.max(maxCenter, center);
  });
  const verticalOffset = SLOT_HEIGHT / 2 - minCenter;
  const height = maxCenter - minCenter + SLOT_HEIGHT;
  const placements = new Map<string, MatchPlacement>();
  rounds.forEach((round, roundIndex) => {
    round.forEach((match, matchIndex) => {
      const centerY = centers.get(match.id);
      if (centerY === undefined) return;
      const midpoint = round.length / 2;
      const x = singleSided
        ? roundIndex * ROUND_STRIDE
        : roundIndex === finalRoundIndex
          ? finalRoundIndex * ROUND_STRIDE
          : matchIndex < midpoint
            ? roundIndex * ROUND_STRIDE
            : (finalRoundIndex * 2 - roundIndex) * ROUND_STRIDE;
      placements.set(match.id, { x, centerY: centerY + verticalOffset });
    });
  });

  return { placements, width, height, finalRoundIndex };
}

function BracketLine({
  x1, y1, x2, y2,
}: { x1: number; y1: number; x2: number; y2: number }) {
  const styles = useBracketStyles();
  const horizontal = y1 === y2;
  return (
    <View
      pointerEvents="none"
      style={[
        styles.connector,
        horizontal
          ? { left: Math.min(x1, x2), top: y1 - 1, width: Math.abs(x2 - x1), height: 2 }
          : { left: x1 - 1, top: Math.min(y1, y2), width: 2, height: Math.abs(y2 - y1) },
      ]}
    />
  );
}

function PairConnector({
  first, second, parent, side,
}: {
  first: MatchPlacement;
  second: MatchPlacement;
  parent: MatchPlacement;
  side: 'left' | 'right';
}) {
  const childEdge = side === 'left' ? first.x + MATCH_WIDTH : first.x;
  const parentEdge = side === 'left' ? parent.x : parent.x + MATCH_WIDTH;
  const spineX = side === 'left' ? childEdge + ROUND_GAP / 2 : childEdge - ROUND_GAP / 2;
  return (
    <>
      <BracketLine x1={childEdge} y1={first.centerY} x2={spineX} y2={first.centerY} />
      <BracketLine x1={childEdge} y1={second.centerY} x2={spineX} y2={second.centerY} />
      <BracketLine x1={spineX} y1={first.centerY} x2={spineX} y2={second.centerY} />
      <BracketLine x1={spineX} y1={parent.centerY} x2={parentEdge} y2={parent.centerY} />
    </>
  );
}

function SingleConnector({
  child, parent, side,
}: {
  child: MatchPlacement;
  parent: MatchPlacement;
  side: 'left' | 'right';
}) {
  const childEdge = side === 'left' ? child.x + MATCH_WIDTH : child.x;
  const parentEdge = side === 'left' ? parent.x : parent.x + MATCH_WIDTH;
  const spineX = side === 'left' ? childEdge + ROUND_GAP / 2 : childEdge - ROUND_GAP / 2;
  return (
    <>
      <BracketLine x1={childEdge} y1={child.centerY} x2={spineX} y2={child.centerY} />
      <BracketLine x1={spineX} y1={child.centerY} x2={spineX} y2={parent.centerY} />
      <BracketLine x1={spineX} y1={parent.centerY} x2={parentEdge} y2={parent.centerY} />
    </>
  );
}

function FinalConnector({
  semifinal, finalX, finalY, playerIndex, side,
}: {
  semifinal: MatchPlacement;
  finalX: number;
  finalY: number;
  playerIndex: number;
  side: 'left' | 'right';
}) {
  const sourceEdge = side === 'left' ? semifinal.x + MATCH_WIDTH : semifinal.x;
  const targetEdge = side === 'left' ? finalX : finalX + MATCH_WIDTH;
  const spineX = side === 'left' ? sourceEdge + ROUND_GAP / 2 : targetEdge + ROUND_GAP / 2;
  const targetY = finalY + (playerIndex === 0 ? -FINAL_PLAYER_OFFSET : FINAL_PLAYER_OFFSET);
  return (
    <>
      <BracketLine x1={sourceEdge} y1={semifinal.centerY} x2={spineX} y2={semifinal.centerY} />
      <BracketLine x1={spineX} y1={semifinal.centerY} x2={spineX} y2={targetY} />
      <BracketLine x1={spineX} y1={targetY} x2={targetEdge} y2={targetY} />
    </>
  );
}

function BracketMatchCard({
  match, isManager, pending, onChooseWinner,
}: {
  match: TournamentBracket['rounds'][number][number];
  isManager: boolean;
  pending: boolean;
  onChooseWinner: (matchId: string, winnerEntrantId: string) => void;
}) {
  const styles = useBracketStyles();
  return (
    <View accessibilityLabel={`Match ${match.matchNumber}`} style={styles.matchCard}>
      {[match.playerOne, match.playerTwo].map((player, playerIndex) => {
        const winner = player?.entrantId === match.winnerEntrantId;
        const rowStyle = [styles.playerRow, playerIndex === 1 && styles.secondPlayerRow];
        const rowContent = (
          <>
            <Text
              numberOfLines={1}
              style={[styles.playerName, winner && styles.winnerName, player && match.winnerEntrantId && !winner && styles.loserName]}
            >
              {player?.name ?? 'TBD'}
            </Text>
            {winner ? <Text style={styles.winnerMark}>✓</Text> : null}
          </>
        );
        if (isManager && player && match.playerOne && match.playerTwo && !match.winnerEntrantId) {
          return (
            <Pressable
              key={player.entrantId}
              accessibilityRole="button"
              accessibilityLabel={`Advance ${player.name}`}
              disabled={pending}
              onPress={() => onChooseWinner(match.id, player.entrantId)}
              style={[...rowStyle, pending && styles.disabled]}
            >
              {rowContent}
            </Pressable>
          );
        }
        return (
          <View
            key={player?.entrantId ?? `empty-${playerIndex}`}
            style={rowStyle}
          >
            {rowContent}
          </View>
        );
      })}
    </View>
  );
}

function BracketTree({
  bracket, isManager, pending, singleSided, onChooseWinner,
}: {
  bracket: TournamentBracket;
  isManager: boolean;
  pending: boolean;
  singleSided: boolean;
  onChooseWinner: (matchId: string, winnerEntrantId: string) => void;
}) {
  const styles = useBracketStyles();
  if (bracket.rounds.length === 0) {
    return bracket.championEntrantId ? (
      <View style={styles.soloChampion}>
        <Text style={styles.championMedal}>🏅</Text>
        <Text style={styles.championName}>
          Champion · {bracket.entrants.find(entrant => entrant.entrantId === bracket.championEntrantId)?.name ?? 'Tournament winner'}
        </Text>
      </View>
    ) : null;
  }

  const { placements, width, height, finalRoundIndex } = getMatchPlacements(bracket.rounds, singleSided);
  const finalMatch = bracket.rounds[finalRoundIndex][0];
  const finalPlacement = placements.get(finalMatch.id);
  const canvasHeight = HEADER_HEIGHT + height + (bracket.championEntrantId ? 66 : 12);
  const connectors: ReactNode[] = [];

  for (let roundIndex = 0; roundIndex < finalRoundIndex - 1; roundIndex += 1) {
    const children = bracket.rounds[roundIndex];
    const parents = bracket.rounds[roundIndex + 1];
    parents.forEach((parent, parentIndex) => {
      const firstMatch = children[parentIndex * 2];
      const secondMatch = children[parentIndex * 2 + 1];
      const parentPlacement = placements.get(parent.id);
      if (!firstMatch || !secondMatch || !parentPlacement) return;
      const firstIsBye = isByeMatch(firstMatch, roundIndex);
      const secondIsBye = isByeMatch(secondMatch, roundIndex);
      const side = singleSided || parentIndex < parents.length / 2 ? 'left' : 'right';
      if (firstIsBye && secondIsBye) return;
      if (firstIsBye || secondIsBye) {
        const child = firstIsBye ? secondMatch : firstMatch;
        const placement = placements.get(child.id);
        if (!placement) return;
        connectors.push(
          <SingleConnector
            key={`connector-${roundIndex}-${parent.matchNumber}`}
            child={placement}
            parent={parentPlacement}
            side={side}
          />,
        );
        return;
      }
      const first = placements.get(firstMatch.id);
      const second = placements.get(secondMatch.id);
      if (!first || !second) return;
      connectors.push(
        <PairConnector
          key={`connector-${roundIndex}-${parent.matchNumber}`}
          first={first}
          second={second}
          parent={parentPlacement}
          side={side}
        />,
      );
    });
  }

  if (finalRoundIndex > 0 && finalPlacement) {
    const semifinals = bracket.rounds[finalRoundIndex - 1];
    semifinals.forEach((semifinal, playerIndex) => {
      if (isByeMatch(semifinal, finalRoundIndex - 1)) return;
      const placement = placements.get(semifinal.id);
      if (!placement) return;
      connectors.push(
        <FinalConnector
          key={`connector-final-${playerIndex}`}
          semifinal={placement}
          finalX={finalPlacement.x}
          finalY={finalPlacement.centerY}
          playerIndex={playerIndex}
          side={singleSided || playerIndex === 0 ? 'left' : 'right'}
        />,
      );
    });
  }

  const labels = bracket.rounds.flatMap((round, roundIndex) => {
    const title = roundTitle(roundIndex + 1, bracket.rounds.length);
    const roundXs = [...new Set(round.flatMap(match => {
      const placement = placements.get(match.id);
      return placement ? [placement.x] : [];
    }))];
    return roundXs.map((x, index) => ({
      key: `label-${roundIndex}-${index}`,
      title,
      x,
    }));
  });

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ minWidth: width }}>
      <View style={[styles.bracketCanvas, { width, height: canvasHeight }]}>
        {labels.map(label => (
          <Text key={label.key} style={[styles.roundLabel, { left: label.x, top: 0, width: MATCH_WIDTH }]}>
            {label.title}
          </Text>
        ))}
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { top: HEADER_HEIGHT }]}>
          {connectors}
        </View>
        {bracket.rounds.flatMap((round, roundIndex) => round.map(match => {
          const placement = placements.get(match.id);
          if (!placement || isByeMatch(match, roundIndex)) return null;
          return (
            <View
              key={match.id}
              style={[
                styles.positionedMatch,
                { left: placement.x, top: HEADER_HEIGHT + placement.centerY - MATCH_HEIGHT / 2 },
              ]}
            >
              <BracketMatchCard
                match={match}
                isManager={isManager}
                pending={pending}
                onChooseWinner={onChooseWinner}
              />
            </View>
          );
        }))}
        {bracket.championEntrantId && (
          <View style={[styles.champion, { left: finalPlacement?.x ?? 0, top: HEADER_HEIGHT + height + 8, width: MATCH_WIDTH }]}>
            <Text style={styles.championMedal}>🏅</Text>
            <Text numberOfLines={1} style={styles.championName}>
              {bracket.entrants.find(entrant => entrant.entrantId === bracket.championEntrantId)?.name ?? 'Tournament winner'}
            </Text>
          </View>
        )}
      </View>
    </ScrollView>
  );
}

export default function TournamentBrackets({ account }: { account: Account }) {
  const { colors } = useAppTheme();
  const styles = useBracketStyles();
  const { width: screenWidth } = useWindowDimensions();
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [bracket, setBracket] = useState<TournamentBracket | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [guestName, setGuestName] = useState('');
  const [guests, setGuests] = useState<BracketGuest[]>([]);
  const [now, setNow] = useState(Date.now());
  const isManager = account.role === 'staff' || account.role === 'admin';
  const bracketEvents = events.filter(event => event.bracketEnabled);
  const activeEvent = bracketEvents
    .filter(event => event.bracketStatus === 'drawn')
    .sort((left, right) => left.occurrenceStart.localeCompare(right.occurrenceStart))[0];
  const pendingEvent = bracketEvents
    .filter(event => event.bracketStatus === null &&
      Date.parse(event.occurrenceStart) < now && event.bracketParticipantCount > 0)
    .sort((left, right) => left.occurrenceStart.localeCompare(right.occurrenceStart))[0];
  const nextEvent = bracketEvents
    .filter(event => event.bracketStatus !== 'completed' && Date.parse(event.occurrenceStart) >= now)
    .sort((left, right) => left.occurrenceStart.localeCompare(right.occurrenceStart))[0];
  const selectedEvent = activeEvent ?? pendingEvent ?? nextEvent;
  const beforeCutoff = Boolean(selectedEvent && Date.parse(selectedEvent.occurrenceStart) > now);

  useEffect(() => {
    let active = true;
    const refreshEvents = async (initial = false) => {
      try {
        const items = await fetchEvents();
        if (active) setEvents(items);
      } catch (caught) {
        console.error('Unable to load events for tournament brackets.', caught);
        if (active) setError(caught instanceof ApiError ? caught.message : 'Unable to load event occurrences.');
      } finally {
        if (initial && active) setLoading(false);
      }
    };
    void refreshEvents(true);
    const interval = setInterval(() => void refreshEvents(), 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedEvent) {
      setBracket(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    const refreshBracket = async (initial = false) => {
      try {
        const result = await fetchEventBracket(selectedEvent.id, selectedEvent.occurrenceStart);
        if (active) setBracket(result);
      } catch (caught) {
        console.error('Unable to load the tournament bracket.', caught);
        if (active) setError(caught instanceof ApiError ? caught.message : 'Unable to load this bracket.');
      } finally {
        if (initial && active) setLoading(false);
      }
    };
    setBracket(null);
    void refreshBracket(true);
    const interval = setInterval(() => void refreshBracket(), 10_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [selectedEvent?.id, selectedEvent?.occurrenceStart]);

  useEffect(() => {
    if (!isManager || !selectedEvent || !beforeCutoff) {
      setGuests([]);
      return;
    }
    let active = true;
    const refreshGuests = async () => {
      try {
        const items = await fetchBracketGuests(selectedEvent.id, selectedEvent.occurrenceStart);
        if (active) setGuests(items);
      } catch (caught) {
        console.error('Unable to load guest tournament entrants.', caught);
        if (active) setError(caught instanceof ApiError ? caught.message : 'Unable to load guest entrants.');
      }
    };
    void refreshGuests();
    const interval = setInterval(() => void refreshGuests(), 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isManager, selectedEvent?.id, selectedEvent?.occurrenceStart, beforeCutoff]);

  async function addGuest() {
    if (!selectedEvent || guestName.trim() === '') return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      await addBracketGuest(selectedEvent.id, selectedEvent.occurrenceStart, guestName.trim());
      setGuestName('');
      setGuests(await fetchBracketGuests(selectedEvent.id, selectedEvent.occurrenceStart));
      setBracket(await fetchEventBracket(selectedEvent.id, selectedEvent.occurrenceStart));
    } catch (caught) {
      console.error('Unable to add a guest tournament entrant.', caught);
      setError(caught instanceof ApiError ? caught.message : 'Unable to add this guest.');
    } finally {
      setPending(false);
    }
  }

  async function removeGuest(guestId: string) {
    if (!selectedEvent) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      await removeBracketGuest(selectedEvent.id, selectedEvent.occurrenceStart, guestId);
      setGuests(await fetchBracketGuests(selectedEvent.id, selectedEvent.occurrenceStart));
      setBracket(await fetchEventBracket(selectedEvent.id, selectedEvent.occurrenceStart));
    } catch (caught) {
      console.error('Unable to remove a guest tournament entrant.', caught);
      setError(caught instanceof ApiError ? caught.message : 'Unable to remove this guest.');
    } finally {
      setPending(false);
    }
  }

  async function chooseWinner(matchId: string, winnerEntrantId: string) {
    if (!selectedEvent) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      setBracket(await recordBracketWinner(
        selectedEvent.id,
        selectedEvent.occurrenceStart,
        matchId,
        winnerEntrantId,
      ));
      setNotice('Result recorded; player advanced.');
      setEvents(await fetchEvents());
    } catch (caught) {
      console.error('Unable to record the bracket winner.', caught);
      setError(caught instanceof ApiError ? caught.message : 'Unable to record the winner.');
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text accessibilityRole="header" style={styles.heading}>Pool tournament</Text>
      <Text style={styles.muted}>The bracket opens automatically when RSVPs close at the event start.</Text>
      {loading && <ActivityIndicator color={colors.brand} />}
      {!loading && !selectedEvent && (
        <Text style={styles.muted}>
          {bracketEvents.length === 0
            ? 'No upcoming tournament is enabled yet.'
            : 'No upcoming tournament occurrence is available.'}
        </Text>
      )}
      {selectedEvent && (
        <View style={styles.panel}>
          <Text style={styles.subheading}>{selectedEvent.title}</Text>
          <Text style={styles.muted}>Event time · {formatEasternDateTime(selectedEvent.occurrenceStart)}</Text>
          <Text style={styles.muted}>RSVP cutoff · {formatEasternDateTime(selectedEvent.occurrenceStart)}</Text>
          {error !== '' && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {notice !== '' && <Text style={styles.notice}>{notice}</Text>}
          {bracket && (
            <>
              {beforeCutoff ? (
                <Text style={styles.muted}>
                  {cutoffCountdown(bracket.cutoffAt, now)} {bracket.participantCount} participant(s) registered.
                </Text>
              ) : bracket.status !== 'not_started' ? (
                <Text style={styles.muted}>
                  {bracket.participantCount} bracket participant(s)
                  {bracket.status === 'completed' ? ' · Tournament complete' : ' · Draw is set'}
                </Text>
              ) : bracket.participantCount === 0 ? (
                <Text style={styles.muted}>No participants registered before RSVPs closed.</Text>
              ) : (
                <Text style={styles.muted}>The randomized bracket is being prepared.</Text>
              )}
              {isManager && beforeCutoff && (
                <View style={styles.guestPanel}>
                  <Text style={styles.roundTitle}>Add a guest player</Text>
                  <Text style={styles.muted}>Guest entries count toward event capacity and are included in the draw.</Text>
                  <View style={styles.guestEntry}>
                    <TextInput
                      accessibilityLabel="Guest player name"
                      maxLength={120}
                      placeholder="Guest name"
                      placeholderTextColor={colors.muted}
                      value={guestName}
                      onChangeText={setGuestName}
                      style={styles.guestInput}
                    />
                    <Pressable
                      accessibilityRole="button"
                      disabled={pending || guestName.trim() === ''}
                      onPress={() => void addGuest()}
                      style={[styles.action, (pending || guestName.trim() === '') && styles.disabled]}
                    >
                      {pending ? <ActivityIndicator color={colors.brandText} /> : <Text style={styles.actionText}>Add</Text>}
                    </Pressable>
                  </View>
                  {guests.map(guest => (
                    <View key={guest.id} style={styles.guestRow}>
                      <Text style={styles.entrant}>{guest.name}</Text>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Remove guest ${guest.name}`}
                        disabled={pending}
                        onPress={() => void removeGuest(guest.id)}
                      >
                        <Text style={styles.removeGuest}>Remove</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}
              <BracketTree
                bracket={bracket}
                isManager={isManager}
                pending={pending}
                singleSided={screenWidth < 600}
                onChooseWinner={(matchId, winnerEntrantId) => void chooseWinner(matchId, winnerEntrantId)}
              />
            </>
          )}
        </View>
      )}
      {!loading && error !== '' && !selectedEvent && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  );
}

function useBracketStyles() {
  const { colors } = useAppTheme();
  return useMemo(() => StyleSheet.create({
    container: { gap: 12 },
    heading: { color: colors.text, fontSize: 24, fontWeight: '700' },
    subheading: { color: colors.text, fontSize: 18, fontWeight: '700' },
    muted: { color: colors.muted, fontSize: 13, lineHeight: 19 },
    panel: { backgroundColor: colors.surface, borderRadius: 16, gap: 12, padding: 16 },
    error: { color: colors.danger, fontSize: 14 },
    notice: { color: colors.brandAccent, fontSize: 14 },
    action: { alignItems: 'center', backgroundColor: colors.brand, borderRadius: 12, minHeight: 44, justifyContent: 'center', padding: 10 },
    disabled: { opacity: 0.55 },
    actionText: { color: colors.brandText, fontWeight: '700' },
    entrantList: { borderTopColor: colors.border, borderTopWidth: 1, gap: 6, paddingTop: 12 },
    roundTitle: { color: colors.brandAccent, fontSize: 16, fontWeight: '700' },
    entrant: { color: colors.text, fontSize: 14 },
    guestPanel: { borderTopColor: colors.border, borderTopWidth: 1, gap: 8, paddingTop: 12 },
    guestEntry: { flexDirection: 'row', gap: 8 },
    guestInput: { backgroundColor: colors.inputBackground, borderColor: colors.border, borderRadius: 10, borderWidth: 1, color: colors.text, flex: 1, minHeight: 44, paddingHorizontal: 12 },
    guestRow: { alignItems: 'center', borderTopColor: colors.border, borderTopWidth: 1, flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
    removeGuest: { color: colors.danger, fontSize: 13, fontWeight: '600' },
    bracketCanvas: { position: 'relative', alignSelf: 'flex-start' },
    roundLabel: { color: colors.brandAccent, fontSize: 13, fontWeight: '700', position: 'absolute', textAlign: 'center' },
    connector: { backgroundColor: colors.muted, position: 'absolute' },
    positionedMatch: { height: MATCH_HEIGHT, position: 'absolute', width: MATCH_WIDTH },
    matchCard: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 7,
      borderWidth: 1,
      height: MATCH_HEIGHT,
      overflow: 'hidden',
      paddingHorizontal: 7,
      width: MATCH_WIDTH,
    },
    playerRow: { alignItems: 'center', flex: 1, flexDirection: 'row', gap: 4 },
    secondPlayerRow: { borderTopColor: colors.border, borderTopWidth: 1 },
    playerName: { color: colors.text, flex: 1, fontSize: 12, minWidth: 0 },
    winnerName: { color: colors.brandAccent, fontWeight: '800' },
    loserName: { color: colors.muted },
    winnerMark: { color: colors.brandAccent, fontSize: 13, fontWeight: '900' },
    champion: { alignItems: 'center', flexDirection: 'row', gap: 4, justifyContent: 'center', position: 'absolute' },
    soloChampion: { alignItems: 'center', borderTopColor: colors.border, borderTopWidth: 1, flexDirection: 'row', gap: 8, justifyContent: 'center', paddingTop: 12 },
    championMedal: { fontSize: 24 },
    championName: { color: colors.brandAccent, fontSize: 14, fontStyle: 'italic', fontWeight: '800', textAlign: 'center' },
  }), [colors]);
}
