export const EVENT_TIME_ZONE = 'America/New_York';

type DateTimeParts = {
  date: string;
  time: string;
};

function partsInEasternTime(date: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: EVENT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
}

export function easternDateTimeParts(value: string): DateTimeParts {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return { date: '', time: '' };
  const parts = partsInEasternTime(date);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function easternDatePart(value: string): string {
  return easternDateTimeParts(value).date;
}

export function easternLocalDateTimeToIso(date: string, time: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || !timeMatch) throw new Error('Choose a valid Eastern date and time.');

  const [year, month, day, hour, minute] = [
    Number(match[1]), Number(match[2]), Number(match[3]), Number(timeMatch[1]), Number(timeMatch[2]),
  ];
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = targetAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = partsInEasternTime(new Date(timestamp));
    const representedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    const difference = targetAsUtc - representedAsUtc;
    if (difference === 0) return new Date(timestamp).toISOString();
    timestamp += difference;
  }
  throw new Error('That local time does not exist in Eastern Time because of a daylight-saving change.');
}

export function formatEasternDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('en-US', { timeZone: EVENT_TIME_ZONE, timeZoneName: 'short' });
}
