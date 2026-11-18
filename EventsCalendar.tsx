import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { easternDatePart } from './easternDateTime';
import type { AppEvent } from './eventsApi';
import { useAppTheme } from './theme';

type Props = {
  events: AppEvent[];
  month: string;
  selectedDate: string;
  onMonthChange: (month: string) => void;
  onSelectDate: (date: string) => void;
};

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default function EventsCalendar({
  events, month, selectedDate, onMonthChange, onSelectDate,
}: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => StyleSheet.create({
    calendar: { backgroundColor: colors.surface, borderRadius: 16, padding: 12, borderWidth: 1, borderColor: colors.border },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    monthTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
    monthButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: colors.subtleButton },
    monthButtonText: { color: colors.subtleButtonText, fontSize: 22, fontWeight: '600' },
    weekdayRow: { flexDirection: 'row', marginBottom: 4 },
    weekday: { flex: 1, color: colors.muted, textAlign: 'center', fontSize: 10, fontWeight: '700' },
    week: { flexDirection: 'row' },
    day: { flex: 1, minWidth: 0, minHeight: 58, margin: 1, paddingVertical: 5, paddingHorizontal: 2, alignItems: 'center', borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
    selectedDay: { backgroundColor: colors.brandSoft, borderColor: colors.brand },
    emptyDay: { flex: 1, minHeight: 58, margin: 1 },
    dayNumber: { color: colors.text, fontSize: 12, fontWeight: '600' },
    selectedDayNumber: { color: colors.brandSoftText },
    eventCount: { color: colors.brandAccent, fontSize: 9, fontWeight: '700', marginTop: 4 },
  }), [colors]);

  const [year, monthNumber] = month.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, monthNumber - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const firstWeekday = firstDay.getUTCDay();
  const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const day = index - firstWeekday + 1;
    return day > 0 && day <= daysInMonth ? `${month}-${String(day).padStart(2, '0')}` : null;
  });
  const eventsByDate = new Map<string, AppEvent[]>();
  for (const event of events) {
    const date = easternDatePart(event.occurrenceStart);
    if (date !== '') {
      const dayEvents = eventsByDate.get(date);
      if (dayEvents) dayEvents.push(event);
      else eventsByDate.set(date, [event]);
    }
  }
  const monthLabel = firstDay.toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  const weekCount = cellCount / 7;

  return (
    <View style={styles.calendar}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Previous month"
          onPress={() => onMonthChange(shiftMonth(month, -1))}
          style={styles.monthButton}
        >
          <Text style={styles.monthButtonText}>‹</Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.monthTitle}>{monthLabel}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Next month"
          onPress={() => onMonthChange(shiftMonth(month, 1))}
          style={styles.monthButton}
        >
          <Text style={styles.monthButtonText}>›</Text>
        </Pressable>
      </View>
      <View style={styles.weekdayRow}>
        {weekdays.map(day => <Text key={day} style={styles.weekday}>{day}</Text>)}
      </View>
      {Array.from({ length: weekCount }, (_, weekIndex) => (
        <View key={weekIndex} style={styles.week}>
          {cells.slice(weekIndex * 7, weekIndex * 7 + 7).map((date, dayIndex) => {
            if (!date) return <View key={`empty-${weekIndex}-${dayIndex}`} style={styles.emptyDay} />;
            const dayEvents = eventsByDate.get(date) ?? [];
            const count = dayEvents.length;
            const selected = date === selectedDate;
            return (
              <Pressable
                key={date}
                accessibilityRole="button"
                accessibilityLabel={`${date}${count ? `, ${count} event${count === 1 ? '' : 's'}: ${dayEvents
                  .map(event => event.title)
                  .join(', ')}` : ', no events'}`}
                accessibilityState={{ selected }}
                onPress={() => onSelectDate(date)}
                style={[styles.day, selected && styles.selectedDay]}
              >
                <Text style={[styles.dayNumber, selected && styles.selectedDayNumber]}>{Number(date.slice(-2))}</Text>
                {count > 0 && <Text style={styles.eventCount}>• {count}</Text>}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}
