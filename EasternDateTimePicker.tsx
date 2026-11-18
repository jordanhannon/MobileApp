import { useMemo } from 'react';
import { View, Text, Platform, StyleSheet } from 'react-native';
import DateTimePicker, { type DateTimePickerChangeEvent } from '@react-native-community/datetimepicker';
import { easternDatePart, EVENT_TIME_ZONE } from './easternDateTime';
import { useAppTheme } from './theme';

export type EasternDateTimePickerProps = {
  label: string;
  value: string;
  mode?: 'datetime' | 'date';
  onChange: (value: string) => void;
};

export default function EasternDateTimePicker({
  label,
  value,
  mode = 'datetime',
  onChange,
}: EasternDateTimePickerProps) {
  const { colors, scheme } = useAppTheme();
  const styles = useMemo(() => StyleSheet.create({
    container: { gap: 5 },
    label: { color: colors.brandAccent, fontSize: 12, fontWeight: '600' },
    androidRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  }), [colors]);
  const selected = value
    ? new Date(mode === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T17:00:00.000Z` : value)
    : new Date();
  const onValueChange = (_event: DateTimePickerChangeEvent, date: Date) => {
    onChange(mode === 'date' ? easternDatePart(date.toISOString()) : date.toISOString());
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label} · Eastern Time</Text>
      {Platform.OS === 'ios' || mode === 'date' ? (
        <DateTimePicker
          value={selected}
          mode={mode === 'date' ? 'date' : 'datetime'}
          display={Platform.OS === 'ios' ? 'compact' : 'default'}
          themeVariant={scheme}
          timeZoneName={EVENT_TIME_ZONE}
          onValueChange={onValueChange}
        />
      ) : (
        <View style={styles.androidRow}>
          <DateTimePicker
            value={selected}
            mode="date"
            themeVariant={scheme}
            timeZoneName={EVENT_TIME_ZONE}
            onValueChange={onValueChange}
          />
          <DateTimePicker
            value={selected}
            mode="time"
            themeVariant={scheme}
            timeZoneName={EVENT_TIME_ZONE}
            is24Hour={false}
            onValueChange={onValueChange}
          />
        </View>
      )}
    </View>
  );
}
