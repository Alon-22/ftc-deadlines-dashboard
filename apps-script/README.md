# Apps Script backend setup

One Apps Script project serves every team's dashboard. Do this once, then repeat step 2–3 per team.

## 1. Create the script project

1. Go to [script.google.com](https://script.google.com) → New project.
2. Delete the default code, paste in the contents of `Code.gs`.
3. Rename the project (e.g. "FTC Deadlines Dashboard Backend").

## 2. Register a team

1. Open the team's Google Sheet, copy its ID from the URL
   (`docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`).
2. In `Code.gs`, add an entry to `TEAMS`:
   ```js
   const TEAMS = {
     redteam: {
       sheetId: '1xuNGLtx8PPptspuuv8CyQvoVTq1vhuHDQBuU1In-MZY',
       calendarId: null,
       mentors: ['Mr. Belkin', 'Zoe'], // exact names as they appear in the goal-owner columns
     },
   };
   ```
   The key (`redteam` here) is what the frontend's `config/teams.js` will reference.
   `mentors` is used to keep mentor-owned personal goals off the student view —
   list the names exactly as they'll be typed into the "Whose goal" column.
3. Save, then run `setupAllTeams` once from the editor's function dropdown (▶ Run).
   The first run asks you to authorize the script — this is expected, since it
   needs edit access to the sheet. It creates the "Competitions & Deadlines",
   "Mentor Notes", and "Dashboard Views" tabs, and backfills the hidden
   Row ID and Priority Order columns on both goal tabs, locating the real
   header row automatically even if there are title/instruction rows above
   it. It's safe to run again any time (e.g. after editing `Code.gs`) — it
   detects and repairs a Row ID column from a previous run rather than
   duplicating it, and never overwrites a Priority Order value that's
   already set.

## 3. Set passcodes

Run `setPasscode_("redteam", "student", "whatever-the-team-uses")` and
`setPasscode_("redteam", "mentor", "something-only-coaches-know")` once each
from the editor (select the function, fill in params via a temporary wrapper
or just edit the call directly, then Run). Until a passcode is set for a
given team+view, writes to that team+view are open — set these before
sharing the link widely.

Alternative: set them by hand in **Project Settings → Script properties** as
`PASSCODE_STUDENT_redteam` / `PASSCODE_MENTOR_redteam`.

## 4. Deploy as a Web App

1. Deploy → New deployment → type: **Web app**.
2. Execute as: **Me**. Who has access: **Anyone with the link**.
3. Deploy, copy the URL (ends in `/exec`).
4. Add it to `config/teams.js` on the frontend as that team's `webAppUrl`.

Whenever you edit `Code.gs`, you need a **new deployment version** (Deploy →
Manage deployments → Edit → New version) for the live URL to pick up the
change — saving alone isn't enough.

## 5. Connect the work-hours calendar (optional, do this later)

Once you have a Google Calendar of actual work sessions:

1. Share it with the same Google account that owns this script (at least
   "See all event details").
2. Get its calendar ID: Calendar settings → that calendar → "Integrate
   calendar" → Calendar ID.
3. Set `calendarId` on that team's entry in `TEAMS` and redeploy.

Until then, `workHoursLeft` comes back `null` and the dashboard just shows
calendar days.
