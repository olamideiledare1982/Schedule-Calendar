// Port of ScheduleParser.swift + ScheduleModels.swift
//
// Interprets the raw table rows produced by pdfExtractor.js according to the
// instructor's schedule rules (skip codes, Reserve/Project Work handling,
// training durations, location/notes formatting).

// The instructor's own employee ID, excluded from student lists in notes.
// Editable in the UI (Settings) — this is just the default.
let INSTRUCTOR_OWN_EMPLOYEE_ID = 'U380460';
function setInstructorEmployeeId(id) {
  INSTRUCTOR_OWN_EMPLOYEE_ID = (id || '').toUpperCase();
}

// --- Codes -----------------------------------------------------------------

// Bug fix (old PWA): RD1 was being treated inconsistently, producing
// duplicate all-day "RD1" entries for the same day when a stray row also
// echoed the code in its description. Skip codes are now checked once,
// against the *effective* code only (never re-derived a second time further
// down the pipeline), matching the Swift version exactly.
// "FLIGHT" is a dateless annotation row the source PDF prints directly under
// an RDO/RD1 day off, showing that a personal trip's flight happened to fall
// on that day (report time + "FS-Flying, Trip ####" description) — it is not
// duty and the day underneath it is still a plain day off, so it's skipped
// exactly like RDO itself (confirmed with the user: these should be ignored).
const SKIP_CODES = new Set(['RDO', 'RD1', 'VDO', 'SD1', 'VACATION', 'FLIGHT']);
const RESERVE_CODE = 'RSV';
const PROJECT_WORK_CODE = 'PW';

const SIX_HOUR_CODES = new Set(['FFS', 'FTDB', 'CQMV', 'CQT', 'CQTL', 'LDRQ', 'QPV', 'QMV', 'ROE']);
const EIGHT_HOUR_CODES = new Set(['ST', 'ACADEMIC', 'PPD', 'EDT', 'OT']);

const PLACEHOLDER_TIME = '02:31';

// --- Regexes -----------------------------------------------------------------

const BID_PERIOD_RE = /Bid Period:\s*(\d{2}\/\d{2}\/\d{2})\s*-\s*(\d{2}\/\d{2}\/\d{2})/;
// "Name U123456" — lazy name capture so it doesn't swallow the next pair.
const PERSON_RE = /([A-Za-z][A-Za-z'.\- ]{1,40}?)\s+(U\d{6})\b/g;
const ORIGINALLY_RDO_RE = /^(.*?)\s*-\s*RDO$/i;
// Explicit "HHMM-HHMM" window in a description, e.g. "XS NO FLEX 0400- 1030".
const EXPLICIT_TIME_RANGE_RE = /(\d{2})(\d{2})\s*-\s*(\d{2})(\d{2})/;

// --- Date helpers --------------------------------------------------------

function parseSlashDate(s) {
  // MM/DD/YY -> Date (local)
  const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(s);
  if (!m) return null;
  const [, mm, dd, yy] = m;
  const year = 2000 + parseInt(yy, 10);
  return new Date(year, parseInt(mm, 10) - 1, parseInt(dd, 10));
}

function formatDay(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function addMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}
function setHourMinute(d, h, m) {
  const r = new Date(d);
  r.setHours(h, m, 0, 0);
  return r;
}

/**
 * Resolves a raw "DD Www" date string into a full calendar Date, tracking
 * month rollover the same way the Swift resolveDate() does: state is
 * threaded through the caller (previousDayOfMonth, monthAnchor), since JS
 * doesn't have Swift's `inout` — callers pass a mutable {value} box for
 * monthAnchor.
 */
function resolveDate(raw, previousDayOfMonth, monthAnchorBox) {
  const parts = raw.split(/\s+/);
  const dayOfMonth = parseInt(parts[0], 10);
  if (!parts.length || Number.isNaN(dayOfMonth)) return null;

  if (previousDayOfMonth !== null && dayOfMonth < previousDayOfMonth) {
    monthAnchorBox.value = addMonths(monthAnchorBox.value, 1);
  }

  const anchor = monthAnchorBox.value;
  const date = new Date(anchor.getFullYear(), anchor.getMonth(), dayOfMonth);
  return { date, dayOfMonth };
}

function parseHourMinute(time) {
  const parts = time.split(':');
  if (parts.length !== 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return [h, m];
}

// --- Students / description split ------------------------------------------

/**
 * Splits "Name U123456 Name2 U234567 Description text" into the list of
 * "Name (U######)" pairs (instructor's own ID excluded) and whatever text is
 * left over, which is the Description column's contents.
 */
function splitStudentsAndDescription(tailText) {
  const students = [];
  const seen = new Set();
  const consumedRanges = [];

  PERSON_RE.lastIndex = 0;
  let match;
  while ((match = PERSON_RE.exec(tailText)) !== null) {
    const name = match[1].trim();
    const employeeID = match[2].toUpperCase();
    consumedRanges.push([match.index, match.index + match[0].length]);

    if (employeeID === INSTRUCTOR_OWN_EMPLOYEE_ID) continue;
    const entry = `${name} (${employeeID})`;
    if (!seen.has(entry)) {
      seen.add(entry);
      students.push(entry);
    }
  }

  // Remove matched "Name ID" spans (reverse order so indices stay valid).
  let remaining = tailText;
  for (const [start, end] of consumedRanges.sort((a, b) => b[0] - a[0])) {
    remaining = remaining.slice(0, start) + ' ' + remaining.slice(end);
  }
  const description = remaining.trim().replace(/\s+/g, ' ');

  return { students, description };
}

function firstWord(s) {
  const parts = s.split(' ').filter(Boolean);
  return parts.length ? parts[0] : s;
}

// --- Location (SIM/Loc column) ----------------------------------------------

/**
 * Bug fix (old PWA): equipment/device text was coming back blank whenever the
 * device name itself contained a space before the parenthesis (e.g.
 * "B767 SIM (D217)"), because the split only looked at the substring before
 * the FIRST paren without trimming stray leading fragments. This mirrors the
 * Swift version exactly: device is everything before '(', room is inside the
 * parens, spaces stripped from device only (never from the room code).
 */
function parseLocation(simLoc, date) {
  const openParen = simLoc.indexOf('(');
  const closeParen = simLoc.indexOf(')');
  if (openParen === -1 || closeParen === -1 || openParen >= closeParen) {
    return { location: null, assumption: null };
  }
  const device = simLoc.slice(0, openParen).trim().replace(/\s+/g, '');
  let room = simLoc.slice(openParen + 1, closeParen).trim();

  if (!device || !room) return { location: null, assumption: null };
  // A real briefing room is a short alphanumeric code (e.g. "BrfE228" or
  // "D217"). Free-text annotations like "(for I/E's)" use parens too, but
  // aren't a room — leave those for the notes fallback instead.
  if (!/^[A-Za-z0-9]+$/.test(room)) return { location: null, assumption: null };

  let assumption = null;
  if (!room.toUpperCase().startsWith('BRF')) {
    assumption = {
      date,
      message: `Briefing room "${room}" on ${formatDay(date)} didn't start with "Brf" — prefixed it automatically.`,
    };
    room = 'Brf' + room;
  }

  return { location: `${room} | ${device}`, assumption };
}

// --- Notes -------------------------------------------------------------------

function buildNotes(studentPairs, simLoc, location, extraNotes) {
  const lines = [];
  if (studentPairs.length) lines.push('Students: ' + studentPairs.join(', '));
  if (location !== null && simLoc) lines.push(`Device/Sim: ${simLoc}`);
  lines.push(...extraNotes);
  return lines.length ? lines.join('\n') : null;
}

/**
 * Looks for an explicit "HHMM-HHMM" window in a description (e.g. "XS NO FLEX
 * 0400- 1030") and returns the end Date it specifies, applied to the same
 * calendar day as startDate. Rolls to the next day if the window crosses
 * midnight.
 */
function parseExplicitEndTime(description, startDate) {
  const match = EXPLICIT_TIME_RANGE_RE.exec(description);
  if (!match) return null;
  const endHour = parseInt(match[3], 10);
  const endMinute = parseInt(match[4], 10);
  if (endHour >= 24 || endMinute >= 60) return null;
  let endDate = setHourMinute(startDate, endHour, endMinute);
  if (endDate <= startDate) endDate = addDays(endDate, 1);
  return endDate;
}

// --- Row interpretation ------------------------------------------------------

/**
 * Most RSV rows are plain standby (no assigned window) and become the
 * generic fixed 04:00-09:00 "Reserve" block. But an RSV row can carry an
 * explicit "HHMM-HHMM" window in its description (e.g. "XS No-Flex
 * 0800-1430") — that means this reserve day has a REAL assigned window
 * during which the instructor can be given work, and the calendar should
 * show that actual window (and the descriptive label) instead of the
 * generic block. Confirmed with the user: when this pattern is seen, use
 * the explicit window as the real start/end and title.
 */
function buildReserveEvent(date, sourceLine) {
  const match = EXPLICIT_TIME_RANGE_RE.exec(sourceLine);
  if (match) {
    const startHour = parseInt(match[1], 10);
    const startMinute = parseInt(match[2], 10);
    const endHour = parseInt(match[3], 10);
    const endMinute = parseInt(match[4], 10);
    if (startHour < 24 && startMinute < 60 && endHour < 24 && endMinute < 60) {
      const start = setHourMinute(date, startHour, startMinute);
      let end = setHourMinute(date, endHour, endMinute);
      if (end <= start) end = addDays(end, 1);

      // Title is the description with the raw "HHMM-HHMM" digits stripped
      // out (the times are now on the event itself), e.g.
      // "XS No-Flex 0800-1430" -> "XS No-Flex".
      const title = sourceLine.replace(EXPLICIT_TIME_RANGE_RE, '').trim().replace(/\s+/g, ' ') || 'Reserve (assigned)';

      const nightBefore = addDays(startOfDay(date), -1);
      const alarm1 = setHourMinute(nightBefore, 20, 0);
      const alarm2 = new Date(start.getTime() - 2 * 3600 * 1000);

      return {
        category: { kind: 'reserve' },
        date, title, isAllDay: false,
        startDate: start, endDate: end,
        location: null, notes: null, alarms: [alarm1, alarm2], sourceLine,
      };
    }
  }

  const start = setHourMinute(date, 4, 0);
  const end = setHourMinute(date, 9, 0);
  return {
    category: { kind: 'reserve' },
    date, title: 'Reserve', isAllDay: false,
    startDate: start, endDate: end,
    location: null, notes: null, alarms: [], sourceLine,
  };
}

function buildProjectWorkEvent(date, sourceLine) {
  return {
    category: { kind: 'projectWork' },
    date, title: 'Project Work', isAllDay: true,
    startDate: null, endDate: null,
    location: null, notes: null, alarms: [], sourceLine,
  };
}

function buildTrainingEvent(raw, date, codeUpper, studentPairs, descriptionRaw, result) {
  const hm = parseHourMinute(raw.start);
  if (!hm) {
    result.unparsedLines.push(`Unrecognized start time '${raw.start}' on ${formatDay(date)} — row skipped.`);
    return null;
  }
  const [hour, minute] = hm;
  const startDate = setHourMinute(date, hour, minute);

  let endDate;
  if (SIX_HOUR_CODES.has(codeUpper)) {
    endDate = new Date(startDate.getTime() + 6 * 3600 * 1000);
  } else if (EIGHT_HOUR_CODES.has(codeUpper)) {
    endDate = new Date(startDate.getTime() + 8 * 3600 * 1000);
  } else {
    const explicitEnd = parseExplicitEndTime(descriptionRaw, startDate);
    if (explicitEnd) {
      endDate = explicitEnd;
      result.assumptions.push({
        date,
        message: `"${codeUpper}" on ${formatDay(date)} isn't a recognized training code — used the explicit time range in its description ("${descriptionRaw}") instead of a default duration.`,
      });
    } else {
      endDate = new Date(startDate.getTime() + 8 * 3600 * 1000);
      result.assumptions.push({
        date,
        message: `"${codeUpper}" on ${formatDay(date)} isn't a recognized training code — assumed an 8-hour duration.`,
      });
    }
  }

  let title = descriptionRaw || codeUpper;
  const extraNotes = [];

  const rdoMatch = ORIGINALLY_RDO_RE.exec(title);
  if (rdoMatch) {
    const stripped = rdoMatch[1].trim();
    if (stripped) {
      extraNotes.push('This day was originally scheduled as RDO; converted to an overtime shift.');
      title = stripped;
    }
  }

  const { location, assumption: locationAssumption } = parseLocation(raw.simLoc, date);
  if (locationAssumption) result.assumptions.push(locationAssumption);
  if (location === null && raw.simLoc) extraNotes.push(`Location: ${raw.simLoc}`);

  const notes = buildNotes(studentPairs, raw.simLoc, location, extraNotes);

  const nightBefore = addDays(startOfDay(date), -1);
  const alarm1 = setHourMinute(nightBefore, 20, 0);
  const alarm2 = new Date(startDate.getTime() - 2 * 3600 * 1000);

  return {
    category: { kind: 'training', code: codeUpper },
    date, title, isAllDay: false,
    startDate, endDate,
    location, notes,
    alarms: [alarm1, alarm2],
    sourceLine: `${raw.simLoc} ${raw.type} ${raw.start} ${raw.tailText}`,
  };
}

function interpret(raw, date, result) {
  const { students: studentPairs, description: descriptionRaw } = splitStudentsAndDescription(raw.tailText);
  // The Description column is sometimes the only place the real code shows
  // up (e.g. an "OT" row whose Type cell was left blank in the source and
  // the code only appears as the leading word of the Description, like
  // "OT 1- RDO"). The effective code is computed ONCE, here, and every
  // downstream check (skip/reserve/project-work/training) uses this same
  // value — this is the fix for the duplicate-RD1 bug, where the old PWA
  // recomputed the code a second time further down and could disagree with
  // itself on borderline rows.
  const effectiveCode = raw.type ? raw.type : firstWord(descriptionRaw);
  const codeUpper = effectiveCode.toUpperCase();

  if (SKIP_CODES.has(codeUpper)) return null;
  // RSV and Project Work rows are checked BEFORE the placeholder-time bail
  // below: a plain RSV day (no assigned work window) is printed with the
  // same "02:31" sentinel start time as RDO/RD1, since it has no real
  // duty time either — but unlike RDO/RD1 it still needs a calendar event
  // (buildReserveEvent's generic 04:00-09:00 block), and neither it nor
  // Project Work actually reads raw.start. Checking the placeholder first
  // (as an earlier version of this did) silently dropped every plain RSV
  // day before it ever reached buildReserveEvent.
  if (codeUpper === RESERVE_CODE) return buildReserveEvent(date, raw.tailText);
  if (codeUpper === PROJECT_WORK_CODE) return buildProjectWorkEvent(date, raw.tailText);

  // Everything else (training codes) needs a real start time; the sentinel
  // means this row has none, so there's nothing to build.
  if (raw.start === PLACEHOLDER_TIME) return null;

  return buildTrainingEvent(raw, date, codeUpper, studentPairs, descriptionRaw, result);
}

// --- Entry point ---------------------------------------------------------

function parseSchedule(bidPeriodLine, rawEvents) {
  const result = {
    bidPeriodStart: null,
    bidPeriodEnd: null,
    addedEvents: [],
    assumptions: [],
    unparsedLines: [],
  };

  if (bidPeriodLine) {
    const m = BID_PERIOD_RE.exec(bidPeriodLine);
    if (m) {
      result.bidPeriodStart = parseSlashDate(m[1]);
      result.bidPeriodEnd = parseSlashDate(m[2]);
    }
  }

  let previousDayOfMonth = null;
  const monthAnchorBox = { value: result.bidPeriodStart || new Date() };

  for (const raw of rawEvents) {
    const resolved = resolveDate(raw.date, previousDayOfMonth, monthAnchorBox);
    if (!resolved) {
      result.unparsedLines.push(
        `Unrecognized date '${raw.date}' — row skipped: ${raw.simLoc} ${raw.type} ${raw.start} ${raw.tailText}`
      );
      continue;
    }
    previousDayOfMonth = resolved.dayOfMonth;

    const event = interpret(raw, resolved.date, result);
    if (event) result.addedEvents.push(event);
  }

  return result;
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseSchedule, setInstructorEmployeeId, splitStudentsAndDescription,
    parseLocation, resolveDate, parseSlashDate, formatDay,
  };
}
