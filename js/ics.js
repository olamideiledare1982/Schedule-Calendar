// Builds an .ics file from ParsedEvent objects, using deterministic UIDs so
// re-importing an updated schedule UPDATES matching events instead of
// duplicating them (Apple/Google/Outlook calendar clients all key off UID on
// import when the calendar already contains that UID).
//
// UID format: UAL-[TYPE]-[YYYYMMDD]-[HHMM]-DEN
//   TYPE  = RSV | PW | the training code (FFS, CQMV, OT, ...)
//   DATE  = the event's calendar day
//   TIME  = the event's start time (or 0000 for all-day Project Work)
//   DEN   = base station suffix, kept fixed per prior convention

const IMPORT_MARKER = 'Added by UA Schedule Importer (PWA)';

function pad2(n) { return String(n).padStart(2, '0'); }

function icsDateUTC(date) {
  // Local wall-clock time is what the schedule means (Denver base), so we
  // emit floating local time with a VTIMEZONE-free TZID, matching how the
  // native app wrote local EventKit times.
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}T${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}
function icsDateOnly(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}
function icsStamp(date) {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}

function typeForCategory(category) {
  if (category.kind === 'reserve') return 'RSV';
  if (category.kind === 'projectWork') return 'PW';
  return category.code;
}

function deterministicUid(event, stationSuffix) {
  const type = typeForCategory(event.category);
  const dateStr = icsDateOnly(event.date);
  const timeStr = event.isAllDay
    ? '0000'
    : `${pad2(event.startDate.getHours())}${pad2(event.startDate.getMinutes())}`;
  return `UAL-${type}-${dateStr}-${timeStr}-${stationSuffix}`;
}

function escapeText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// RFC 5545 requires folding lines longer than 75 octets; most calendar apps
// tolerate long lines, but we fold anyway for correctness.
function foldLine(line) {
  if (line.length <= 75) return line;
  let result = '';
  let rest = line;
  result += rest.slice(0, 75);
  rest = rest.slice(75);
  while (rest.length > 0) {
    result += '\r\n ' + rest.slice(0, 74);
    rest = rest.slice(74);
  }
  return result;
}

function buildVEvent(event, { stationSuffix, sequence, nowStamp }) {
  const uid = deterministicUid(event, stationSuffix) + '@uascheduleimporter.local';
  const lines = [];
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${uid}`);
  lines.push(`DTSTAMP:${nowStamp}`);
  lines.push(`SEQUENCE:${sequence}`);
  lines.push(`SUMMARY:${escapeText(event.title)}`);

  if (event.isAllDay) {
    lines.push(`DTSTART;VALUE=DATE:${icsDateOnly(event.date)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDateOnly(addDays(event.date, 1))}`);
  } else {
    lines.push(`DTSTART;TZID=America/Denver:${icsDateUTC(event.startDate)}`);
    lines.push(`DTEND;TZID=America/Denver:${icsDateUTC(event.endDate)}`);
  }

  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);

  const noteParts = [event.notes, IMPORT_MARKER].filter(Boolean);
  // Join with REAL newlines (not the 2-character "\n" sequence) so
  // escapeText's \n-escaping below produces exactly one escaped break per
  // join, instead of double-escaping a literal backslash.
  if (noteParts.length) lines.push(`DESCRIPTION:${escapeText(noteParts.join('\n\n'))}`);

  for (const alarmDate of event.alarms || []) {
    const minutesBefore = event.startDate
      ? Math.round((event.startDate.getTime() - alarmDate.getTime()) / 60000)
      : 0;
    lines.push('BEGIN:VALARM');
    lines.push('ACTION:DISPLAY');
    lines.push(`DESCRIPTION:${escapeText(event.title)}`);
    lines.push(`TRIGGER:-PT${Math.max(minutesBefore, 0)}M`);
    lines.push('END:VALARM');
  }

  lines.push('END:VEVENT');
  return lines.map(foldLine).join('\r\n');
}

function addDays(date, n) {
  const r = new Date(date);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * Builds a full .ics calendar document from an array of ParsedEvent objects.
 * `calendarName` sets X-WR-CALNAME, a hint some clients use to suggest a
 * target calendar on import (not a hard guarantee — Apple Calendar still
 * lets the user pick).
 */
function buildIcs(events, { calendarName = 'UA Schedule', stationSuffix = 'DEN' } = {}) {
  const nowStamp = icsStamp(new Date());
  const lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//UA Schedule Importer//PWA//EN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(`X-WR-CALNAME:${escapeText(calendarName)}`);

  for (const event of events) {
    lines.push(buildVEvent(event, { stationSuffix, sequence: 0, nowStamp }));
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

if (typeof module !== 'undefined') {
  module.exports = { buildIcs, deterministicUid, IMPORT_MARKER };
}
