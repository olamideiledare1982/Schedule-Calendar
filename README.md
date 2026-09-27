# Schedule-Calendar

A PWA that parses a United instructor schedule PDF and generates a calendar (.ics) file to import.

Open the live page (once GitHub Pages is enabled for this repo) or `index.html` directly to use it. Install it to your phone's home screen for persistent, installable use (avoids the periodic storage-eviction issue plain browser tabs run into).

## What it does

1. Upload your monthly schedule PDF (exported from the United Instructor Schedule system).
2. It parses the PDF entirely on-device (no data leaves your browser) using the same row/column logic as the original native iOS app.
3. Review the parsed events, assumptions made, and any skipped/unparsed rows.
4. Download a `.ics` file and import it into your calendar app.

Re-importing an updated schedule won't create duplicate events — each event has a deterministic ID based on its type, date, and time, so calendar apps update matching events instead of duplicating them.
