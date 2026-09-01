# FTC Deadlines Dashboard

A front end for FTC teams' Google Sheet: countdowns to competitions and
goal deadlines (in both calendar days and work hours), a drag-to-reschedule
Gantt timeline, a weekly check-in scoreboard, season-long analytics, and a
lightweight metric builder — synced both ways with the Sheet. No separate
database — the Sheet is the store.

- **`index.html`** — student view. Open link, no login.
- **`mentor.html`** — mentor/coach view. Passcode-gated. Mentors' own goals
  plus a free-form notes log the head coach reads.
- Both views share six tabs:
  - **Deadlines** — countdown cards (Team goals / Personal goals), with a
    compact "Key dates" widget pinned to the top-right so competitions and
    deadlines are visible at a glance without competing for space.
  - **To-Do** — one printable list per person, built from goals due that
    calendar week, with addable/checkable sub-tasks. Every sub-task is a
    row in the Subtasks sheet tab — that tab accumulates as the season-end
    record for judges, no separate archival step needed.
  - **Timeline** — separate Team and Personal Gantt charts (drag a bar to
    reschedule it) plus a Priority list per goal tab (drag or use the
    arrows to reorder, independent of dates).
  - **Check-In** — due this/next week, overdue, red-flagged, and "done
    this last week" buckets, plus the status scoreboard and per-subteam
    breakdown — all computed live from the same data shown on Deadlines.
  - **Season** — the Sheet's Season Log as a browsable table, plus trend
    charts (completions per month, on-time vs late, per-subteam).
  - **Metrics** — build and save a simple group-by/filter view over Goals
    or the Season Log; saved views are shared with the whole team.
- **`app.js`** — core: fetch/state/passcode, tabs, the Deadlines cards. It
  exposes `window.DB`, the shared surface `gantt.js`/`checkin.js`/`todo.js`/
  `season.js`/`metrics.js`/`charts.js` use to reach the same data and
  write helpers without a bundler.
- **`apps-script/`** — the sync backend (Google Apps Script Web App). See
  [`apps-script/README.md`](apps-script/README.md) for deploy steps.
- **`config/teams.js`** — maps each team to its deployed backend URL.

## Local development

No build step. Serve the folder and open it in a browser:

```bash
python3 -m http.server 8000
```

Then visit `http://localhost:8000/index.html` (or `/mentor.html`). You need
at least one team registered in `config/teams.js` pointing at a real,
deployed Apps Script Web App URL — see `apps-script/README.md`.

## Deploying

1. Set up the Apps Script backend first (`apps-script/README.md`).
2. Fill in `config/teams.js` with each team's key/label/URL.
3. Push this repo to GitHub, enable Pages (Settings → Pages → deploy from
   branch, root).

**Cache-busting**: `index.html`/`mentor.html` load every local script/style
with a `?v=<short-sha>` query string, since GitHub Pages caches static
files for 10 minutes and browsers often hold on to them well past that —
without it, people can sit on a stale cached version after a deploy until
they think to hard-refresh. **Bump that `?v=` value to the new commit's
short SHA on every push that touches `app.js`/`gantt.js`/`charts.js`/
`checkin.js`/`todo.js`/`season.js`/`metrics.js`/`style.css`/`config/teams.js`** —
a quick `sed -i '' "s/v=OLDSHA/v=NEWSHA/g" index.html mentor.html` after
committing (then amend, or just commit the bump too) keeps it in sync.

## Notes

- Days-left stays a Sheet formula, never written to. The Sheet's own Gantt,
  Weekly Check-In, and Subteam View tabs are untouched — this dashboard
  recomputes those views itself from Team Goals/Personal Goals rather than
  depending on their formula layout, so the Sheet's own tabs and the
  dashboard can't drift out of sync with each other. It does read the
  Season Log tab, and reads/writes Team Goals, Personal Goals, Competitions
  & Deadlines, Mentor Notes, Dashboard Views (for saved metrics/filters),
  and Subtasks (for the To-Do tab).
- The Subtasks tab is append/toggle-only — the frontend never deletes a row
  from it — so it doubles as the season-long record of weekly individual
  goals and progress: pull it directly at season's end for judges rather
  than needing a separate "save this week" archival step.
- Dragging a Gantt bar writes Start date/Target date back to the Sheet.
  Dragging in a Priority list writes a new "Priority Order" column that's
  independent of dates — added and self-healed the same way the hidden
  Row ID column is.
- Passcodes are shared secrets typed into the browser each session
  (`sessionStorage`, never written to disk or git) — a light deterrent, not
  real auth. Don't put anything in Mentor Notes you wouldn't want visible
  to whoever has the mentor passcode.
