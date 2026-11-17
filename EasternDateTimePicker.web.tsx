import { createElement, useEffect, useState, type ChangeEvent, type CSSProperties } from 'react';
import { Text, View } from 'react-native';
import type { EasternDateTimePickerProps } from './EasternDateTimePicker';
import { easternDateTimeParts, easternLocalDateTimeToIso, EVENT_TIME_ZONE } from './easternDateTime';

const fieldStyle: CSSProperties = {
  backgroundColor: '#FAF9F5',
  borderColor: '#DDE2D6',
  borderRadius: 10,
  borderStyle: 'solid',
  borderWidth: 1,
  boxSizing: 'border-box',
  color: '#233B2B',
  font: 'inherit',
  minHeight: 44,
  padding: '9px 12px',
  width: '100%',
};

function DateInput({
  type,
  label,
  value,
  onChange,
}: {
  type: 'date' | 'time';
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return createElement('input', {
    type,
    'aria-label': label,
    value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.value),
    style: { ...fieldStyle, maxWidth: type === 'date' ? 240 : 180 },
  });
}

export default function EasternDateTimePicker({
  label,
  value,
  mode = 'datetime',
  onChange,
}: EasternDateTimePickerProps) {
  const [error, setError] = useState('');
  const parts = value.length > 10
    ? easternDateTimeParts(value)
    : { date: value, time: '' };
  const [date, setDate] = useState(parts.date);
  const [time, setTime] = useState(parts.time);

  useEffect(() => {
    setDate(parts.date);
    setTime(parts.time);
  }, [parts.date, parts.time]);

  function update(date: string, time: string) {
    if (mode === 'date') {
      onChange(date);
      setError('');
      return;
    }
    setDate(date);
    setTime(time);
    if (date === '' || time === '') {
      onChange('');
      setError('');
      return;
    }
    try {
      onChange(easternLocalDateTimeToIso(date, time));
      setError('');
    } catch (caught) {
      onChange('');
      setError(caught instanceof Error ? caught.message : 'Choose a valid Eastern date and time.');
    }
  }

  return (
    <View style={{ gap: 5 }}>
      <Text style={{ color: '#426046', fontSize: 12, fontWeight: '600' }}>{label} · Eastern Time</Text>
      {mode === 'date' ? (
        <DateInput type="date" label={label} value={date} onChange={nextDate => update(nextDate, '')} />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <DateInput
            type="date"
            label={`${label} date`}
            value={date}
            onChange={nextDate => update(nextDate, time)}
          />
          <DateInput
            type="time"
            label={`${label} time`}
            value={time}
            onChange={nextTime => update(date, nextTime)}
          />
        </View>
      )}
      {error !== '' && <Text accessibilityLiveRegion="polite" style={{ color: '#A12A24', fontSize: 12 }}>{error}</Text>}
      <Text style={{ color: '#657064', fontSize: 11 }}>Saved in {EVENT_TIME_ZONE}; daylight-saving changes are handled automatically.</Text>
    </View>
  );
}
