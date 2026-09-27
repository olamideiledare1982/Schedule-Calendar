/* global pdfjsLib, extractFromPdf, parseSchedule, setInstructorEmployeeId, buildIcs */

const SETTINGS_KEY = 'ua-schedule-importer-settings-v1';

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { employeeId: 'U380460', calendarName: 'UA Schedule', stationSuffix: 'DEN' };
}
function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

let settings = loadSettings();
let lastResult = null;

const el = {
  fileInput: document.getElementById('fileInput'),
  dropZone: document.getElementById('dropZone'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  summary: document.getElementById('summary'),
  assumptions: document.getElementById('assumptions'),
  unparsed: document.getElementById('unparsed'),
  eventList: document.getElementById('eventList'),
  downloadBtn: document.getElementById('downloadBtn'),
  debugToggle: document.getElementById('debugToggle'),
  debugTable: document.getElementById('debugTable'),
  employeeId: document.getElementById('employeeId'),
  calendarName: document.getElementById('calendarName'),
  stationSuffix: document.getElementById('stationSuffix'),
  persistBadge: document.getElementById('persistBadge'),
};

el.employeeId.value = settings.employeeId;
el.calendarName.value = settings.calendarName;
el.stationSuffix.value = settings.stationSuffix;
setInstructorEmployeeId(settings.employeeId);

[el.employeeId, el.calendarName, el.stationSuffix].forEach((input) => {
  input.addEventListener('change', () => {
    settings = {
      employeeId: el.employeeId.value.trim().toUpperCase() || 'U380460',
      calendarName: el.calendarName.value.trim() || 'UA Schedule',
      stationSuffix: el.stationSuffix.value.trim().toUpperCase() || 'DEN',
    };
    saveSettings(settings);
    setInstructorEmployeeId(settings.employeeId);
  });
});

function setStatus(msg, isError = false) {
  el.status.textContent = msg;
  el.status.className = isError ? 'status error' : 'status';
}

async function handleFile(file) {
  if (!file) return;
  setStatus(`Reading ${file.name}...`);
  el.results.hidden = true;
  el.downloadBtn.disabled = true;

  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    setStatus('Extracting table rows...');
    const { bidPeriodLine, events: rawEvents } = await extractFromPdf(pdf);

    if (!rawEvents.length) {
      setStatus('No recognizable schedule rows were found in this PDF.', true);
      return;
    }

    setStatus('Parsing schedule rules...');
    const result = parseSchedule(bidPeriodLine, rawEvents);
    lastResult = result;
    renderResult(result, rawEvents);
    setStatus(`Done — ${result.addedEvents.length} event(s) ready.`);
    el.downloadBtn.disabled = result.addedEvents.length === 0;
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't read that PDF: ${err.message || err}`, true);
  }
}

function renderResult(result, rawEvents) {
  el.results.hidden = false;

  const bidRange = result.bidPeriodStart && result.bidPeriodEnd
    ? `${result.bidPeriodStart.toLocaleDateString()} – ${result.bidPeriodEnd.toLocaleDateString()}`
    : 'not found in PDF';
  el.summary.textContent = `Bid period: ${bidRange}  •  ${result.addedEvents.length} event(s) to import  •  ${result.unparsedLines.length} row(s) skipped/unparsed`;

  el.eventList.innerHTML = '';
  for (const ev of result.addedEvents) {
    const li = document.createElement('li');
    const when = ev.isAllDay
      ? ev.date.toLocaleDateString()
      : `${ev.startDate.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} – ${ev.endDate.toLocaleTimeString([], { timeStyle: 'short' })}`;
    li.innerHTML = `<strong>${escapeHtml(ev.title)}</strong><br><span class="meta">${when}${ev.location ? ' · ' + escapeHtml(ev.location) : ''}</span>`;
    el.eventList.appendChild(li);
  }

  el.assumptions.innerHTML = '';
  for (const a of result.assumptions) {
    const li = document.createElement('li');
    li.textContent = a.message;
    el.assumptions.appendChild(li);
  }
  document.getElementById('assumptionsSection').hidden = result.assumptions.length === 0;

  el.unparsed.innerHTML = '';
  for (const line of result.unparsedLines) {
    const li = document.createElement('li');
    li.textContent = line;
    el.unparsed.appendChild(li);
  }
  document.getElementById('unparsedSection').hidden = result.unparsedLines.length === 0;

  el.debugTable.innerHTML = '';
  const header = document.createElement('tr');
  ['Date', 'SIM/Loc', 'Type', 'Start', 'Tail (students/description)'].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    header.appendChild(th);
  });
  el.debugTable.appendChild(header);
  for (const raw of rawEvents) {
    const tr = document.createElement('tr');
    [raw.date, raw.simLoc, raw.type, raw.start, raw.tailText].forEach((v) => {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    });
    el.debugTable.appendChild(tr);
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

el.debugToggle.addEventListener('click', () => {
  const table = document.getElementById('debugSection');
  table.hidden = !table.hidden;
  el.debugToggle.textContent = table.hidden ? 'Show raw extracted rows' : 'Hide raw extracted rows';
});

el.downloadBtn.addEventListener('click', () => {
  if (!lastResult || !lastResult.addedEvents.length) return;
  const ics = buildIcs(lastResult.addedEvents, {
    calendarName: settings.calendarName,
    stationSuffix: settings.stationSuffix,
  });
  const blob = new Blob([ics], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `ua-schedule-${stamp}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

el.fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

['dragenter', 'dragover'].forEach((evt) =>
  el.dropZone.addEventListener(evt, (e) => { e.preventDefault(); el.dropZone.classList.add('drag'); })
);
['dragleave', 'drop'].forEach((evt) =>
  el.dropZone.addEventListener(evt, (e) => { e.preventDefault(); el.dropZone.classList.remove('drag'); })
);
el.dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});
el.dropZone.addEventListener('click', () => el.fileInput.click());

// Ask iOS/Android to exempt this app's storage from periodic eviction. This,
// combined with manifest display:standalone and being launched from the
// home-screen icon (not a Safari tab), is what actually prevents the 7-day
// wipe the old attempt hit.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().then((granted) => {
    el.persistBadge.textContent = granted ? 'Persistent storage: on' : 'Persistent storage: not granted (install to home screen to enable)';
    el.persistBadge.className = granted ? 'badge ok' : 'badge warn';
  });
} else {
  el.persistBadge.textContent = 'Persistent storage: unsupported in this browser';
  el.persistBadge.className = 'badge warn';
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
}
