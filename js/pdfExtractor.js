// Port of RunPDFExtractor.swift
//
// Reconstructs the instructor schedule's table rows directly from the PDF's
// text layout. pdf.js's per-page text items (in emitted order) turn out to
// already be the JS equivalent of PDFKit's selectionsByLine() output — see
// pageItemsToLines() below — so this re-derives row boundaries using the
// Start-time column as the anchor, exactly as the Swift version does.

function isDateRun(s) {
  return /^\d{1,2}\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(s);
}
function isTimeRun(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
function isTypeCode(s) {
  return /^[A-Za-z][A-Za-z0-9]{0,7}$/.test(s);
}
function containsEmployeeID(s) {
  return /U\d{6}/.test(s);
}
function looksLikeLocationFragment(s) {
  if (/\(brf/i.test(s)) return true;
  if (s.includes('#')) return true;
  if (/\/[A-Za-z ]+,\s*[A-Z]{2}$/.test(s)) return true;
  if (/^[A-Za-z]-?\d{2,3}[A-Za-z]?-?$/.test(s)) return true;
  const opens = (s.match(/\(/g) || []).length;
  const closes = (s.match(/\)/g) || []).length;
  return opens !== closes;
}
function isFooterMarker(s) {
  return s.includes('http')
    || /report generated/i.test(s)
    || (/page /i.test(s) && / of /i.test(s));
}

/**
 * Turns a page's pdf.js text items into the same per-cell "line" fragments
 * that PDFKit's selectionsByLine() gives the Swift extractor.
 *
 * Calibrated directly against a real exported schedule PDF (via a raw
 * pdf.js item dump): each table cell is written as its own independent
 * text-showing item in the content stream — "2 Sun", "CQMV", "08:00" all
 * arrive as separate, already-complete items, in reading order, regardless
 * of whether they share a Y coordinate (most short cells in one row do) or
 * differ (a wrapped SIM/Loc or Student cell spills onto its own Y just
 * above/below the row). pdf.js's item order already follows the source's
 * row-by-row, column-by-column writing order, so no Y-bucketing or
 * horizontal-gap-based re-joining is needed — that was tried and is WRONG:
 * it collapses adjacent cells (which sit on the same Y with a huge X gap)
 * into one fused string, breaking every regex-based column check below.
 * pdf.js also emits standalone empty-string and whitespace-only items
 * (rendering artifacts); those are simply dropped.
 */
function pageItemsToLines(textContent) {
  const texts = [];
  for (const item of textContent.items) {
    if (typeof item.str !== 'string') continue;
    const trimmed = item.str.trim();
    if (trimmed) texts.push(trimmed);
  }
  return texts;
}

/**
 * Public entry point. `pdfjsDoc` is a pdf.js PDFDocumentProxy.
 * Returns { bidPeriodLine, events } exactly like RunPDFExtractor.extract().
 */
async function extractFromPdf(pdfjsDoc) {
  let bidPeriodLine = null;
  const allTexts = [];

  for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
    const page = await pdfjsDoc.getPage(pageNum);
    const textContent = await page.getTextContent();

    if (bidPeriodLine === null) {
      const pageString = textContent.items.map(i => i.str).join(' ');
      const idx = pageString.indexOf('Bid Period:');
      if (idx !== -1) {
        const tail = pageString.slice(idx);
        const newlineIdx = tail.indexOf('\n');
        bidPeriodLine = newlineIdx !== -1 ? tail.slice(0, newlineIdx) : tail;
      }
    }

    const texts = pageItemsToLines(textContent);

    let startIdx = 0;
    const headerEnd = texts.findIndex(t => t === 'Description');
    if (headerEnd !== -1) startIdx = headerEnd + 1;
    if (startIdx >= texts.length) continue;

    for (let idx = startIdx; idx < texts.length; idx++) {
      const t = texts[idx];
      if (!t) continue;
      if (isFooterMarker(t)) break;
      allTexts.push(t);
    }
  }

  if (allTexts.length === 0) return { bidPeriodLine, events: [] };

  return { bidPeriodLine, events: reconstructRows(allTexts) };
}

/**
 * Same anchor-based reconstruction as the Swift extractEvents(), operating on
 * an already-flattened array of per-line text strings. Exported separately so
 * it can be unit-tested with hand-built fixtures instead of a real PDF.
 */
function reconstructRows(allTexts) {
  const anchors = [];
  for (let i = 0; i < allTexts.length; i++) {
    if (isTimeRun(allTexts[i])) {
      const typeIdx = (i > 0 && isTypeCode(allTexts[i - 1])) ? i - 1 : null;
      anchors.push({ timeIdx: i, typeIdx });
    }
  }
  if (anchors.length === 0) return [];

  const events = [];
  let pendingDateIndices = [];
  let mostRecentDate = '';

  anchors.forEach((anchor, n) => {
    const prevAnchorTimeIdx = n > 0 ? anchors[n - 1].timeIdx : -1;
    const searchStart = prevAnchorTimeIdx + 1;
    const searchEnd = (anchor.typeIdx ?? anchor.timeIdx) - 1;

    let gap = [];
    if (searchEnd >= searchStart) {
      gap = allTexts.slice(searchStart, searchEnd + 1);
    }

    let dateValue = null;
    const dateRunIdx = gap.findIndex(isDateRun);
    if (dateRunIdx !== -1) {
      dateValue = gap[dateRunIdx];
      gap.splice(dateRunIdx, 1);
    }

    // Backward-scan remaining gap for a contiguous suffix of location-looking
    // fragments; everything before that suffix is the previous event's
    // trailing student/description text.
    let splitPoint = gap.length;
    let k = gap.length - 1;
    while (k >= 0) {
      const t = gap[k];
      if (containsEmployeeID(t)) break;
      if (looksLikeLocationFragment(t)) {
        splitPoint = k;
        k -= 1;
      } else {
        break;
      }
    }

    const tailForPrevious = gap.slice(0, splitPoint).join(' ');
    const simLocForThis = gap.slice(splitPoint).join(' ');

    if (n > 0) {
      events[events.length - 1].tailText = tailForPrevious;
    }

    const newEvent = {
      date: '',
      simLoc: simLocForThis,
      type: anchor.typeIdx !== null ? allTexts[anchor.typeIdx] : '',
      start: allTexts[anchor.timeIdx],
      tailText: '',
    };

    if (dateValue) {
      mostRecentDate = dateValue;
      for (const idx of pendingDateIndices) events[idx].date = mostRecentDate;
      pendingDateIndices = [];
      newEvent.date = mostRecentDate;
    } else {
      newEvent.date = mostRecentDate;
      pendingDateIndices.push(events.length);
    }

    events.push(newEvent);
  });

  const last = anchors[anchors.length - 1];
  const afterLastAnchor = last.timeIdx + 1;
  if (afterLastAnchor < allTexts.length) {
    events[events.length - 1].tailText = allTexts.slice(afterLastAnchor).join(' ');
  }

  return events;
}

if (typeof module !== 'undefined') {
  module.exports = { extractFromPdf, reconstructRows, isDateRun, isTimeRun, isTypeCode, containsEmployeeID, looksLikeLocationFragment, isFooterMarker };
}
