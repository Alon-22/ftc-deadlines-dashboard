# FTC Deadlines Dashboard

A small dashboard for FTC teams: countdowns to competitions and goal
deadlines (in both calendar days and work hours), synced both ways with
each team's Google Sheet. No separate database — the Sheet is the store.

- **`index.html`** — student view. Open link, no login. Countdowns +
  editable notes/status.
- **`mentor.html`** — mentor/coach view. Passcode-gated. Mentors' own goals
  plus a free-form notes log the head coach reads.
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

## Notes

- Days-left and formulas already in the Sheet (Gantt, Weekly Check-In,
  Season Log, Subteam View) are untouched — this only reads/writes the
  Team Goals, Personal Goals, Competitions & Deadlines, and Mentor Notes
  tabs.
- Passcodes are shared secrets typed into the browser each session
  (`sessionStorage`, never written to disk or git) — a light deterrent, not
  real auth. Don't put anything in Mentor Notes you wouldn't want visible
  to whoever has the mentor passcode.
