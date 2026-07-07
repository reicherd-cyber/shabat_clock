import { validation } from '../config/errors.js';

const DAY_MINUTES = 1440;
const WEEK_MINUTES = 7 * DAY_MINUTES;

function parseTimeToMinutes(value, field) {
  const text = String(value || '');
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(text);
  if (!match) {
    throw validation('VALIDATION', 'Invalid schedule time', { [field]: 'Expected HH:MM minute granularity' });
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeDay(day, field) {
  if (day === null || day === undefined || day === '') return null;
  const number = Number(day);
  if (!Number.isInteger(number) || number < 1 || number > 7) {
    throw validation('VALIDATION', 'Invalid day of week', { [field]: 'Expected integer 1..7 or null' });
  }
  return number;
}

function dateTimeMs(date, time) {
  return Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}+00:00`);
}

export function validateSchedule(schedule, { now = new Date() } = {}) {
  const repeatType = schedule.repeat_type || 'weekly';
  const onMin = parseTimeToMinutes(schedule.on_time, 'on_time');
  const offMin = parseTimeToMinutes(schedule.off_time, 'off_time');

  if (repeatType === 'weekly') {
    if (schedule.on_date || schedule.off_date) {
      throw validation('VALIDATION', 'Weekly schedules cannot have dates', {
        on_date: 'must be null',
        off_date: 'must be null',
      });
    }
    const onDay = normalizeDay(schedule.on_day_of_week, 'on_day_of_week');
    const offDay = normalizeDay(schedule.off_day_of_week, 'off_day_of_week');
    if ((onDay === null) !== (offDay === null)) {
      throw validation('VALIDATION', 'Schedule days must both be set or both be daily', {
        on_day_of_week: 'must match off_day_of_week nullness',
        off_day_of_week: 'must match on_day_of_week nullness',
      });
    }

    const duration = onDay === null
      ? (offMin - onMin + DAY_MINUTES) % DAY_MINUTES
      : ((offDay * DAY_MINUTES + offMin) - (onDay * DAY_MINUTES + onMin) + WEEK_MINUTES) % WEEK_MINUTES;

    if (duration <= 0) throw validation('ZERO_LENGTH_PAIR', 'Schedule ON and OFF cannot be identical');
    return { ...schedule, repeat_type: 'weekly', on_day_of_week: onDay, off_day_of_week: offDay };
  }

  if (repeatType === 'once') {
    if (!schedule.on_date || !schedule.off_date) {
      throw validation('VALIDATION', 'Once schedules require dates', {
        on_date: 'required',
        off_date: 'required',
      });
    }
    const onMs = dateTimeMs(schedule.on_date, schedule.on_time);
    const offMs = dateTimeMs(schedule.off_date, schedule.off_time);
    if (!Number.isFinite(onMs) || !Number.isFinite(offMs)) {
      throw validation('VALIDATION', 'Invalid once schedule date/time');
    }
    if (offMs <= onMs) throw validation('OFF_BEFORE_ON', 'OFF must be after ON');
    if (onMs <= now.getTime()) throw validation('ALREADY_PAST', 'ON time must be in the future');
    return {
      ...schedule,
      repeat_type: 'once',
      on_day_of_week: null,
      off_day_of_week: null,
    };
  }

  throw validation('VALIDATION', 'Invalid repeat_type', { repeat_type: 'Expected weekly or once' });
}
