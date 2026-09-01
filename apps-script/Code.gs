/**
 * FTC Deadlines Dashboard — shared backend.
 *
 * One standalone Apps Script project serves every team. Deploy as a Web App
 * (Execute as: Me, Who has access: Anyone with the link), then paste the
 * deployment URL into config/teams.js on the frontend for each team.
 *
 * Setup, per team:
 *   1. Add an entry to TEAMS below (sheetId required, calendarId optional —
 *      leave null until you share a work-sessions calendar).
 *   2. Set the passcodes for that team in File > Project properties >
 *      Script properties (or run setPasscode_ once from the editor):
 *        PASSCODE_STUDENT_<teamKey>
 *        PASSCODE_MENTOR_<teamKey>
 *      If a property is left unset, that gate is treated as open (no
 *      passcode required) — useful while testing, tighten before rollout.
 *   3. Run setupAllTeams() once from the Apps Script editor (Run menu).
 *      It creates the "Competitions & Deadlines" and "Mentor Notes" tabs
 *      and backfills a hidden Row ID column on every goal tab, if missing.
 */

// ===== Team registry =====================================================

const TEAMS = {
   MysteryMeat: {
     sheetId: '1xuNGLtx8PPptspuuv8CyQvoVTq1vhuHDQBuU1In-MZY',
     calendarId: null, // fill in once the work-sessions calendar is shared
   },
};

// ===== Sheet schema ========================================================

const GOAL_TAB_CONFIGS = [
  {
    sheetName: 'Team Goals',
    subtype: 'team',
    columns: {
      goal: 'Goal (one sentence)',
      owner: 'Owner (one name)',
      group: 'Subteam',
      startDate: 'Start date',
      targetDate: 'Target date',
      status: 'Status',
      lastUpdate: 'Last update (what moved)',
    },
  },
  {
    sheetName: 'Personal Goals',
    subtype: 'personal',
    columns: {
      goal: 'Goal (one sentence)',
      owner: 'Whose goal',
      group: 'Skill area',
      startDate: 'Start date',
      targetDate: 'Target date',
      status: 'Status',
      lastUpdate: 'Last update (what moved)',
    },
  },
];

const DEADLINES_TAB = 'Competitions & Deadlines';
const DEADLINES_COLUMNS = ['Event name', 'Date', 'Type', 'Notes', 'Row ID'];
const DEADLINES_TYPES = ['Competition', 'Registration', 'Ship date', 'Other'];

const MENTOR_NOTES_TAB = 'Mentor Notes';
const MENTOR_NOTES_COLUMNS = ['Date', 'Mentor', 'Note', 'Row ID'];

const ROW_ID_COLUMN = 'Row ID';
const MENTORS_TAB = 'Students, Mentors, Sub Teams'; // adjust if your reference tab is named differently
const MENTORS_HEADER = 'Mentors';

// Editable fields on goal tabs — anything else (Days left formulas, dates,
// goal text) is left alone by writes.
const EDITABLE_GOAL_FIELDS = ['status', 'lastUpdate'];

// ===== HTTP entry points ===================================================

function doGet(e) {
  return handleRequest_(e, false);
}

function doPost(e) {
  return handleRequest_(e, true);
}

function handleRequest_(e, isPost) {
  var result;
  try {
    var params = isPost ? JSON.parse(e.postData.contents) : (e.parameter || {});
    result = isPost ? handleWrite_(params) : handleRead_(params);
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return jsonOut_(result);
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.JSON);
}

// ===== Read =================================================================

function handleRead_(params) {
  var teamKey = params.team;
  var view = params.view === 'mentor' ? 'mentor' : 'student';
  var team = TEAMS[teamKey];
  if (!team) return { ok: false, error: 'Unknown team: ' + teamKey };

  if (view === 'mentor' && !checkPasscode_(teamKey, 'mentor', params.passcode)) {
    return { ok: false, error: 'Invalid or missing mentor passcode' };
  }

  var ss = SpreadsheetApp.openById(team.sheetId);
  var now = new Date();
  var calendar = team.calendarId ? safeGetCalendar_(team.calendarId) : null;
  var hoursCache = {};
  var mentors = readMentorList_(ss);

  var items = [];

  // Goals (Team Goals + Personal Goals)
  GOAL_TAB_CONFIGS.forEach(function(cfg) {
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) return;
    var table = readSheetRows_(sheet);
    table.rows.forEach(function(row) {
      var goal = cell_(row, table.headerIndex, cfg.columns.goal);
      if (!goal) return;
      var owner = cell_(row, table.headerIndex, cfg.columns.owner);
      var isMentorOwned = cfg.subtype === 'personal' && ownerIsMentor_(owner, mentors);
      if (view === 'student' && isMentorOwned) return; // keep mentor thinking off the student view

      var targetDate = toDate_(cell_(row, table.headerIndex, cfg.columns.targetDate));
      items.push({
        type: 'goal',
        subtype: cfg.subtype,
        id: cell_(row, table.headerIndex, ROW_ID_COLUMN),
        title: goal,
        owner: owner,
        group: cell_(row, table.headerIndex, cfg.columns.group),
        targetDate: targetDate ? targetDate.toISOString() : null,
        status: cell_(row, table.headerIndex, cfg.columns.status),
        notes: cell_(row, table.headerIndex, cfg.columns.lastUpdate),
        daysLeft: daysLeft_(now, targetDate),
        workHoursLeft: workHoursLeft_(calendar, now, targetDate, hoursCache),
        isMentorOwned: isMentorOwned,
      });
    });
  });

  // Competitions & Deadlines
  var deadlinesSheet = ss.getSheetByName(DEADLINES_TAB);
  if (deadlinesSheet) {
    var dTable = readSheetRows_(deadlinesSheet);
    dTable.rows.forEach(function(row) {
      var title = cell_(row, dTable.headerIndex, 'Event name');
      if (!title) return;
      var targetDate = toDate_(cell_(row, dTable.headerIndex, 'Date'));
      items.push({
        type: 'deadline',
        subtype: cell_(row, dTable.headerIndex, 'Type') || 'Other',
        id: cell_(row, dTable.headerIndex, ROW_ID_COLUMN),
        title: title,
        owner: '',
        group: '',
        targetDate: targetDate ? targetDate.toISOString() : null,
        status: '',
        notes: cell_(row, dTable.headerIndex, 'Notes'),
        daysLeft: daysLeft_(now, targetDate),
        workHoursLeft: workHoursLeft_(calendar, now, targetDate, hoursCache),
        isMentorOwned: false,
      });
    });
  }

  var payload = { ok: true, generatedAt: now.toISOString(), items: items };

  if (view === 'mentor') {
    payload.mentorNotes = readMentorNotes_(ss);
  }

  return payload;
}

function readMentorNotes_(ss) {
  var sheet = ss.getSheetByName(MENTOR_NOTES_TAB);
  if (!sheet) return [];
  var table = readSheetRows_(sheet);
  var notes = [];
  table.rows.forEach(function(row) {
    var note = cell_(row, table.headerIndex, 'Note');
    if (!note) return;
    var date = toDate_(cell_(row, table.headerIndex, 'Date'));
    notes.push({
      id: cell_(row, table.headerIndex, ROW_ID_COLUMN),
      mentor: cell_(row, table.headerIndex, 'Mentor'),
      note: note,
      date: date ? date.toISOString() : null,
    });
  });
  notes.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });
  return notes;
}

// ===== Write ================================================================

function handleWrite_(params) {
  var teamKey = params.team;
  var view = params.view === 'mentor' ? 'mentor' : 'student';
  var team = TEAMS[teamKey];
  if (!team) return { ok: false, error: 'Unknown team: ' + teamKey };
  if (!checkPasscode_(teamKey, view, params.passcode)) {
    return { ok: false, error: 'Invalid or missing passcode' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.openById(team.sheetId);
    switch (params.action) {
      case 'updateGoal':
        return updateGoal_(ss, params.id, params.fields || {});
      case 'addDeadline':
        return addDeadline_(ss, params.fields || {});
      case 'updateDeadline':
        return updateDeadline_(ss, params.id, params.fields || {});
      case 'addPersonalGoal':
        return addPersonalGoal_(ss, params.fields || {});
      case 'addMentorNote':
        if (view !== 'mentor') return { ok: false, error: 'Mentor notes require the mentor view' };
        return addMentorNote_(ss, params.fields || {});
      default:
        return { ok: false, error: 'Unknown action: ' + params.action };
    }
  } finally {
    lock.releaseLock();
  }
}

function updateGoal_(ss, rowId, fields) {
  if (!rowId) return { ok: false, error: 'Missing id' };
  for (var i = 0; i < GOAL_TAB_CONFIGS.length; i++) {
    var cfg = GOAL_TAB_CONFIGS[i];
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) continue;
    var table = readSheetRows_(sheet);
    var match = table.rows.filter(function(row) {
      return cell_(row, table.headerIndex, ROW_ID_COLUMN) === rowId;
    })[0];
    if (!match) continue;

    EDITABLE_GOAL_FIELDS.forEach(function(field) {
      if (!(field in fields)) return;
      var headerName = cfg.columns[field];
      setCell_(sheet, match.rowNum, table.headerIndex, headerName, fields[field]);
    });
    return { ok: true };
  }
  return { ok: false, error: 'Row not found: ' + rowId };
}

function addDeadline_(ss, fields) {
  var sheet = ss.getSheetByName(DEADLINES_TAB);
  if (!sheet) return { ok: false, error: 'Missing "' + DEADLINES_TAB + '" tab — run setupAllTeams() first' };
  if (!fields.title || !fields.targetDate) return { ok: false, error: 'title and targetDate are required' };
  var id = Utilities.getUuid();
  sheet.appendRow([
    fields.title,
    toDate_(fields.targetDate) || fields.targetDate,
    DEADLINES_TYPES.indexOf(fields.subtype) >= 0 ? fields.subtype : 'Other',
    fields.notes || '',
    id,
  ]);
  return { ok: true, id: id };
}

function updateDeadline_(ss, rowId, fields) {
  var sheet = ss.getSheetByName(DEADLINES_TAB);
  if (!sheet || !rowId) return { ok: false, error: 'Row not found' };
  var table = readSheetRows_(sheet);
  var match = table.rows.filter(function(row) {
    return cell_(row, table.headerIndex, ROW_ID_COLUMN) === rowId;
  })[0];
  if (!match) return { ok: false, error: 'Row not found: ' + rowId };
  if ('notes' in fields) setCell_(sheet, match.rowNum, table.headerIndex, 'Notes', fields.notes);
  if ('status' in fields) setCell_(sheet, match.rowNum, table.headerIndex, 'Type', fields.status);
  return { ok: true };
}

function addPersonalGoal_(ss, fields) {
  var sheet = ss.getSheetByName('Personal Goals');
  if (!sheet) return { ok: false, error: 'Missing "Personal Goals" tab' };
  if (!fields.title || !fields.owner) return { ok: false, error: 'title and owner are required' };
  var table = readSheetRows_(sheet);
  var id = Utilities.getUuid();
  var row = [];
  var cfg = GOAL_TAB_CONFIGS.filter(function(c) { return c.sheetName === 'Personal Goals'; })[0];
  var lastCol = Math.max.apply(null, Object.keys(table.headerIndex).map(function(h) { return table.headerIndex[h]; })) + 1;
  for (var i = 0; i < lastCol; i++) row.push('');
  row[table.headerIndex[cfg.columns.goal]] = fields.title;
  row[table.headerIndex[cfg.columns.owner]] = fields.owner;
  if (cfg.columns.group && table.headerIndex[cfg.columns.group] !== undefined) row[table.headerIndex[cfg.columns.group]] = fields.group || '';
  if (table.headerIndex[cfg.columns.startDate] !== undefined) row[table.headerIndex[cfg.columns.startDate]] = new Date();
  if (fields.targetDate && table.headerIndex[cfg.columns.targetDate] !== undefined) row[table.headerIndex[cfg.columns.targetDate]] = toDate_(fields.targetDate);
  row[table.headerIndex[cfg.columns.status]] = fields.status || 'Not started';
  if (table.headerIndex[ROW_ID_COLUMN] !== undefined) row[table.headerIndex[ROW_ID_COLUMN]] = id;
  sheet.appendRow(row);
  return { ok: true, id: id };
}

function addMentorNote_(ss, fields) {
  var sheet = ss.getSheetByName(MENTOR_NOTES_TAB);
  if (!sheet) return { ok: false, error: 'Missing "' + MENTOR_NOTES_TAB + '" tab — run setupAllTeams() first' };
  if (!fields.note || !fields.mentor) return { ok: false, error: 'note and mentor are required' };
  var id = Utilities.getUuid();
  sheet.appendRow([new Date(), fields.mentor, fields.note, id]);
  return { ok: true, id: id };
}

// ===== Sheet helpers ========================================================

function readSheetRows_(sheet) {
  var values = sheet.getDataRange().getValues();
  var headers = values[0] || [];
  var headerIndex = {};
  headers.forEach(function(h, i) { if (h) headerIndex[h] = i; });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    rows.push({ rowNum: r + 1, raw: values[r] });
  }
  return { headerIndex: headerIndex, rows: rows };
}

function cell_(row, headerIndex, name) {
  var idx = headerIndex[name];
  if (idx === undefined) return '';
  var v = row.raw[idx];
  return v === null || v === undefined ? '' : v;
}

function setCell_(sheet, rowNum, headerIndex, name, value) {
  var idx = headerIndex[name];
  if (idx === undefined) idx = ensureColumn_(sheet, name, headerIndex);
  sheet.getRange(rowNum, idx + 1).setValue(value);
}

function ensureColumn_(sheet, name, headerIndex) {
  var col = sheet.getLastColumn() + 1;
  sheet.getRange(1, col).setValue(name);
  headerIndex[name] = col - 1;
  return col - 1;
}

function toDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function daysLeft_(now, targetDate) {
  if (!targetDate) return null;
  var ms = targetDate.getTime() - now.getTime();
  return Math.ceil(ms / 86400000);
}

function safeGetCalendar_(calendarId) {
  try {
    return CalendarApp.getCalendarById(calendarId);
  } catch (err) {
    return null;
  }
}

function workHoursLeft_(calendar, now, targetDate, cache) {
  if (!calendar || !targetDate) return null;
  if (targetDate.getTime() <= now.getTime()) return 0;
  var key = targetDate.getTime();
  if (cache[key] !== undefined) return cache[key];
  var totalMs = 0;
  var events = calendar.getEvents(now, targetDate);
  events.forEach(function(ev) {
    if (ev.isAllDayEvent()) return;
    totalMs += (ev.getEndTime().getTime() - ev.getStartTime().getTime());
  });
  var hours = Math.round((totalMs / 3600000) * 10) / 10;
  cache[key] = hours;
  return hours;
}

function readMentorList_(ss) {
  var sheet = ss.getSheetByName(MENTORS_TAB);
  if (!sheet) return [];
  var table = readSheetRows_(sheet);
  var idx = table.headerIndex[MENTORS_HEADER];
  if (idx === undefined) return [];
  var mentors = [];
  table.rows.forEach(function(row) {
    var v = row.raw[idx];
    if (v && String(v).trim() && String(v).trim().toLowerCase() !== 'not assigned') {
      mentors.push(String(v).trim());
    }
  });
  return mentors;
}

function ownerIsMentor_(owner, mentors) {
  if (!owner) return false;
  var names = String(owner).split(',').map(function(s) { return s.trim(); });
  return names.some(function(n) { return mentors.indexOf(n) >= 0; });
}

// ===== Passcodes ============================================================

function checkPasscode_(teamKey, view, passcode) {
  var expected = PropertiesService.getScriptProperties()
      .getProperty('PASSCODE_' + view.toUpperCase() + '_' + teamKey);
  if (!expected) return true; // no passcode configured yet == open (tighten before rollout)
  return passcode === expected;
}

/** Run manually (select in the editor, then Run) to set a passcode. */
function setPasscode_(teamKey, view, passcode) {
  PropertiesService.getScriptProperties()
      .setProperty('PASSCODE_' + view.toUpperCase() + '_' + teamKey, passcode);
}

// ===== One-time per-team sheet setup =======================================

/** Run manually from the editor after populating TEAMS. */
function setupAllTeams() {
  Object.keys(TEAMS).forEach(function(teamKey) {
    setupTeamSheet_(TEAMS[teamKey].sheetId);
  });
}

function setupTeamSheet_(sheetId) {
  var ss = SpreadsheetApp.openById(sheetId);

  ensureTab_(ss, DEADLINES_TAB, DEADLINES_COLUMNS);
  ensureTab_(ss, MENTOR_NOTES_TAB, MENTOR_NOTES_COLUMNS);

  GOAL_TAB_CONFIGS.forEach(function(cfg) {
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (sheet) backfillRowIds_(sheet);
  });
  var deadlinesSheet = ss.getSheetByName(DEADLINES_TAB);
  if (deadlinesSheet) backfillRowIds_(deadlinesSheet);
  var notesSheet = ss.getSheetByName(MENTOR_NOTES_TAB);
  if (notesSheet) backfillRowIds_(notesSheet);
}

function ensureTab_(ss, name, columns) {
  var sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
  sheet.setFrozenRows(1);
  return sheet;
}

function backfillRowIds_(sheet) {
  var table = readSheetRows_(sheet);
  var idx = table.headerIndex[ROW_ID_COLUMN];
  if (idx === undefined) idx = ensureColumn_(sheet, ROW_ID_COLUMN, table.headerIndex);
  table.rows.forEach(function(row) {
    var firstCellHasContent = row.raw.some(function(v) { return v !== '' && v !== null; });
    if (!firstCellHasContent) return;
    var existing = row.raw[idx];
    if (!existing) {
      sheet.getRange(row.rowNum, idx + 1).setValue(Utilities.getUuid());
    }
  });
}
