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
    calendarId: 'c_75dae7e7b71d6c86414525f344f9018a0b245cc08756965c47c23fbc47e812f7@group.calendar.google.com',
    mentors: ['Mr. Belkin', 'Zoe'], // exact names as they appear in "Whose goal" / owner columns
  },
  // example: {
  //   sheetId: '1xuNGLtx8PPptspuuv8CyQvoVTq1vhuHDQBuU1In-MZY',
  //   calendarId: null, // fill in once the work-sessions calendar is shared
  //   mentors: ['Mr. Belkin', 'Zoe'], // exact names as they appear in "Whose goal" / owner columns
  // },
};

// ===== Sheet schema ========================================================

const ROW_ID_COLUMN = 'Row ID';
const PRIORITY_ORDER_COLUMN = 'Priority Order';

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
      priorityOrder: PRIORITY_ORDER_COLUMN,
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
      priorityOrder: PRIORITY_ORDER_COLUMN,
    },
  },
];

const DEADLINES_TAB = 'Competitions & Deadlines';
const DEADLINES_COLUMNS = ['Event name', 'Date', 'Type', 'Notes', 'Row ID'];
const DEADLINES_TYPES = ['Competition', 'Registration', 'Ship date', 'Other'];

const MENTOR_NOTES_TAB = 'Mentor Notes';
const MENTOR_NOTES_COLUMNS = ['Date', 'Mentor', 'Note', 'Row ID'];

const SEASON_LOG_TAB = 'Season Log';

const VIEWS_TAB = 'Dashboard Views';
const VIEWS_COLUMNS = ['Name', 'Config', 'Created By', 'Row ID'];

// Sub-tasks under a weekly goal, generated from the To-Do tab. This tab IS
// the season-long judges record — nothing else archives it, so rows are
// never deleted by normal use, only ever appended/toggled. "Week Of" is the
// Monday of the calendar week the sub-task was created in, so a season-end
// pull can group by week without recomputing it from Created At.
const SUBTASKS_TAB = 'Subtasks';
const SUBTASKS_COLUMNS = ['Goal ID', 'Owner', 'Week Of', 'Text', 'Done', 'Created At', 'Completed At', 'Row ID'];

// Editable fields on goal tabs via updateGoal — Days left stays a formula
// column and is never listed here. startDate/targetDate are writable so the
// Gantt's drag-to-reschedule can move them; Priority Order is only ever
// written in bulk via reorderGoals_, never through this path.
const EDITABLE_GOAL_FIELDS = ['status', 'lastUpdate', 'startDate', 'targetDate'];

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
    if (params.action === 'mintToken') {
      result = mintToken_(params.team, params.view === 'mentor' ? 'mentor' : 'student', params.passcode);
    } else {
      result = isPost ? handleWrite_(params) : handleRead_(params);
    }
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
  var mentors = team.mentors || [];

  var items = [];

  // Goals (Team Goals + Personal Goals)
  GOAL_TAB_CONFIGS.forEach(function(cfg) {
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) return;
    var table = readSheetRows_(sheet, cfg.columns.goal);
    table.rows.forEach(function(row) {
      var goal = textCell_(row, table.headerIndex, cfg.columns.goal);
      if (!goal) return;
      var owner = textCell_(row, table.headerIndex, cfg.columns.owner);
      var isMentorOwned = cfg.subtype === 'personal' && ownerIsMentor_(owner, mentors);
      if (view === 'student' && isMentorOwned) return; // keep mentor thinking off the student view

      var startDate = toDate_(cell_(row, table.headerIndex, cfg.columns.startDate));
      var targetDate = toDate_(cell_(row, table.headerIndex, cfg.columns.targetDate));
      var priorityRaw = cell_(row, table.headerIndex, cfg.columns.priorityOrder);
      items.push({
        type: 'goal',
        subtype: cfg.subtype,
        id: cell_(row, table.headerIndex, ROW_ID_COLUMN),
        title: goal,
        owner: owner,
        group: textCell_(row, table.headerIndex, cfg.columns.group),
        startDate: startDate ? startDate.toISOString() : null,
        targetDate: targetDate ? targetDate.toISOString() : null,
        status: textCell_(row, table.headerIndex, cfg.columns.status),
        notes: textCell_(row, table.headerIndex, cfg.columns.lastUpdate),
        priorityOrder: priorityRaw === '' ? null : Number(priorityRaw),
        daysLeft: daysLeft_(now, targetDate),
        workHoursLeft: workHoursLeft_(calendar, now, targetDate, hoursCache),
        isMentorOwned: isMentorOwned,
      });
    });
  });

  // Competitions & Deadlines
  var deadlinesSheet = ss.getSheetByName(DEADLINES_TAB);
  if (deadlinesSheet) {
    var dTable = readSheetRows_(deadlinesSheet, 'Event name');
    dTable.rows.forEach(function(row) {
      var title = textCell_(row, dTable.headerIndex, 'Event name');
      if (!title) return;
      var targetDate = toDate_(cell_(row, dTable.headerIndex, 'Date'));
      items.push({
        type: 'deadline',
        subtype: textCell_(row, dTable.headerIndex, 'Type') || 'Other',
        id: cell_(row, dTable.headerIndex, ROW_ID_COLUMN),
        title: title,
        owner: '',
        group: '',
        targetDate: targetDate ? targetDate.toISOString() : null,
        status: '',
        notes: textCell_(row, dTable.headerIndex, 'Notes'),
        daysLeft: daysLeft_(now, targetDate),
        workHoursLeft: workHoursLeft_(calendar, now, targetDate, hoursCache),
        isMentorOwned: false,
      });
    });
  }

  var payload = {
    ok: true,
    generatedAt: now.toISOString(),
    items: items,
    seasonLog: readSeasonLog_(ss),
    views: readViews_(ss),
    subtasks: readSubtasks_(ss),
  };

  if (view === 'mentor') {
    payload.mentorNotes = readMentorNotes_(ss);
  }

  return payload;
}

function readSeasonLog_(ss) {
  var sheet = ss.getSheetByName(SEASON_LOG_TAB);
  if (!sheet) return [];
  var table = readSheetRows_(sheet, 'Archived on');
  var rows = [];
  table.rows.forEach(function(row) {
    var title = textCell_(row, table.headerIndex, 'Goal');
    if (!title) return;
    var startDate = toDate_(cell_(row, table.headerIndex, 'Start date'));
    var targetDate = toDate_(cell_(row, table.headerIndex, 'Target date'));
    var finishedOn = toDate_(cell_(row, table.headerIndex, 'Finished on'));
    var archivedOn = toDate_(cell_(row, table.headerIndex, 'Archived on'));
    var varianceRaw = cell_(row, table.headerIndex, 'Early (-) / Late (+)');
    rows.push({
      type: textCell_(row, table.headerIndex, 'Type'),
      title: title,
      owner: textCell_(row, table.headerIndex, 'Owner'),
      group: textCell_(row, table.headerIndex, 'Subteam / skill'),
      startDate: startDate ? startDate.toISOString() : null,
      targetDate: targetDate ? targetDate.toISOString() : null,
      finishedOn: finishedOn ? finishedOn.toISOString() : null,
      varianceDays: varianceRaw === '' ? null : Number(varianceRaw),
      notes: textCell_(row, table.headerIndex, 'Notes / who I told'),
      archivedOn: archivedOn ? archivedOn.toISOString() : null,
    });
  });
  return rows;
}

function readViews_(ss) {
  var sheet = ss.getSheetByName(VIEWS_TAB);
  if (!sheet) return [];
  var table = readSheetRows_(sheet, 'Name');
  var views = [];
  table.rows.forEach(function(row) {
    var name = textCell_(row, table.headerIndex, 'Name');
    if (!name) return;
    var config = {};
    try { config = JSON.parse(textCell_(row, table.headerIndex, 'Config')); } catch (err) { config = {}; }
    views.push({
      id: cell_(row, table.headerIndex, ROW_ID_COLUMN),
      name: name,
      config: config,
      createdBy: textCell_(row, table.headerIndex, 'Created By'),
    });
  });
  return views;
}

function readSubtasks_(ss) {
  var sheet = ss.getSheetByName(SUBTASKS_TAB);
  if (!sheet) return [];
  var table = readSheetRows_(sheet, 'Text');
  var subtasks = [];
  table.rows.forEach(function(row) {
    var text = textCell_(row, table.headerIndex, 'Text');
    if (!text) return;
    var createdAt = toDate_(cell_(row, table.headerIndex, 'Created At'));
    var completedAt = toDate_(cell_(row, table.headerIndex, 'Completed At'));
    subtasks.push({
      id: cell_(row, table.headerIndex, ROW_ID_COLUMN),
      goalId: textCell_(row, table.headerIndex, 'Goal ID'),
      owner: textCell_(row, table.headerIndex, 'Owner'),
      weekOf: textCell_(row, table.headerIndex, 'Week Of'),
      text: text,
      done: String(cell_(row, table.headerIndex, 'Done')).toUpperCase() === 'TRUE',
      createdAt: createdAt ? createdAt.toISOString() : null,
      completedAt: completedAt ? completedAt.toISOString() : null,
    });
  });
  return subtasks;
}

function readMentorNotes_(ss) {
  var sheet = ss.getSheetByName(MENTOR_NOTES_TAB);
  if (!sheet) return [];
  var table = readSheetRows_(sheet, 'Note');
  var notes = [];
  table.rows.forEach(function(row) {
    var note = textCell_(row, table.headerIndex, 'Note');
    if (!note) return;
    var date = toDate_(cell_(row, table.headerIndex, 'Date'));
    notes.push({
      id: cell_(row, table.headerIndex, ROW_ID_COLUMN),
      mentor: textCell_(row, table.headerIndex, 'Mentor'),
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
      case 'addTeamGoal':
        return addTeamGoal_(ss, params.fields || {});
      case 'addMentorNote':
        if (view !== 'mentor') return { ok: false, error: 'Mentor notes require the mentor view' };
        return addMentorNote_(ss, params.fields || {});
      case 'reorderGoals':
        return reorderGoals_(ss, params.fields || {});
      case 'addSubtask':
        return addSubtask_(ss, params.fields || {});
      case 'toggleSubtask':
        return toggleSubtask_(ss, params.id, params.fields || {});
      case 'deleteSubtask':
        return deleteSubtask_(ss, params.id);
      case 'saveView':
        return saveView_(ss, params.id, params.fields || {});
      case 'deleteView':
        return deleteView_(ss, params.id);
      default:
        return { ok: false, error: 'Unknown action: ' + params.action };
    }
  } finally {
    lock.releaseLock();
  }
}

/** Locates a row by Row ID within one already-known sheet. */
function findRowInSheetById_(sheet, anchorHeader, rowId) {
  var table = readSheetRows_(sheet, anchorHeader);
  var match = table.rows.filter(function(row) {
    return cell_(row, table.headerIndex, ROW_ID_COLUMN) === rowId;
  })[0];
  return match ? { table: table, match: match } : null;
}

/** Locates a row by Row ID across both goal tabs. */
function findGoalRow_(ss, rowId) {
  for (var i = 0; i < GOAL_TAB_CONFIGS.length; i++) {
    var cfg = GOAL_TAB_CONFIGS[i];
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) continue;
    var found = findRowInSheetById_(sheet, cfg.columns.goal, rowId);
    if (found) return { cfg: cfg, sheet: sheet, table: found.table, match: found.match };
  }
  return null;
}

function updateGoal_(ss, rowId, fields) {
  if (!rowId) return { ok: false, error: 'Missing id' };
  var found = findGoalRow_(ss, rowId);
  if (!found) return { ok: false, error: 'Row not found: ' + rowId };

  EDITABLE_GOAL_FIELDS.forEach(function(field) {
    if (!(field in fields)) return;
    var headerName = found.cfg.columns[field];
    var value = fields[field];
    if (field === 'startDate' || field === 'targetDate') value = toDate_(value) || value;
    setCell_(found.sheet, found.match.rowNum, found.table.headerIndex, headerName, value, found.table.headerRowNum);
  });
  return { ok: true };
}

/** Batched priority reorder for one goal tab — one lock, sequential Priority Order writes. */
function reorderGoals_(ss, fields) {
  var sheetName = fields.sheetName;
  var order = fields.order;
  if (!sheetName || !Array.isArray(order)) return { ok: false, error: 'sheetName and order are required' };
  var cfg = GOAL_TAB_CONFIGS.filter(function(c) { return c.sheetName === sheetName; })[0];
  if (!cfg) return { ok: false, error: 'Unknown sheetName: ' + sheetName };
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { ok: false, error: 'Missing "' + sheetName + '" tab' };
  var table = readSheetRows_(sheet, cfg.columns.goal);
  order.forEach(function(rowId, i) {
    var match = table.rows.filter(function(row) {
      return cell_(row, table.headerIndex, ROW_ID_COLUMN) === rowId;
    })[0];
    if (match) setCell_(sheet, match.rowNum, table.headerIndex, cfg.columns.priorityOrder, i + 1, table.headerRowNum);
  });
  return { ok: true };
}

function saveView_(ss, id, fields) {
  var sheet = ss.getSheetByName(VIEWS_TAB);
  if (!sheet) return { ok: false, error: 'Missing "' + VIEWS_TAB + '" tab — run setupAllTeams() first' };
  if (!fields.name || !fields.config) return { ok: false, error: 'name and config are required' };
  var configStr = typeof fields.config === 'string' ? fields.config : JSON.stringify(fields.config);
  if (id) {
    var found = findRowInSheetById_(sheet, 'Name', id);
    if (found) {
      setCell_(sheet, found.match.rowNum, found.table.headerIndex, 'Name', fields.name, found.table.headerRowNum);
      setCell_(sheet, found.match.rowNum, found.table.headerIndex, 'Config', configStr, found.table.headerRowNum);
      setCell_(sheet, found.match.rowNum, found.table.headerIndex, 'Created By', fields.createdBy || '', found.table.headerRowNum);
      return { ok: true, id: id };
    }
  }
  var newId = Utilities.getUuid();
  sheet.appendRow([fields.name, configStr, fields.createdBy || '', newId]);
  return { ok: true, id: newId };
}

function deleteView_(ss, id) {
  var sheet = ss.getSheetByName(VIEWS_TAB);
  if (!sheet || !id) return { ok: false, error: 'Missing view' };
  var found = findRowInSheetById_(sheet, 'Name', id);
  if (!found) return { ok: false, error: 'View not found: ' + id };
  sheet.deleteRow(found.match.rowNum);
  return { ok: true };
}

function addSubtask_(ss, fields) {
  var sheet = ss.getSheetByName(SUBTASKS_TAB);
  if (!sheet) return { ok: false, error: 'Missing "' + SUBTASKS_TAB + '" tab — run setupAllTeams() first' };
  if (!fields.goalId || !fields.text) return { ok: false, error: 'goalId and text are required' };
  var id = Utilities.getUuid();
  sheet.appendRow([
    fields.goalId,
    fields.owner || '',
    fields.weekOf || '',
    fields.text,
    false,
    new Date(),
    '',
    id,
  ]);
  return { ok: true, id: id };
}

function toggleSubtask_(ss, id, fields) {
  var sheet = ss.getSheetByName(SUBTASKS_TAB);
  if (!sheet || !id) return { ok: false, error: 'Row not found' };
  var found = findRowInSheetById_(sheet, 'Text', id);
  if (!found) return { ok: false, error: 'Row not found: ' + id };
  var done = !!fields.done;
  setCell_(sheet, found.match.rowNum, found.table.headerIndex, 'Done', done, found.table.headerRowNum);
  setCell_(sheet, found.match.rowNum, found.table.headerIndex, 'Completed At', done ? new Date() : '', found.table.headerRowNum);
  return { ok: true };
}

function deleteSubtask_(ss, id) {
  var sheet = ss.getSheetByName(SUBTASKS_TAB);
  if (!sheet || !id) return { ok: false, error: 'Missing subtask' };
  var found = findRowInSheetById_(sheet, 'Text', id);
  if (!found) return { ok: false, error: 'Row not found: ' + id };
  sheet.deleteRow(found.match.rowNum);
  return { ok: true };
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
  var found = findRowInSheetById_(sheet, 'Event name', rowId);
  if (!found) return { ok: false, error: 'Row not found: ' + rowId };
  if ('notes' in fields) setCell_(sheet, found.match.rowNum, found.table.headerIndex, 'Notes', fields.notes, found.table.headerRowNum);
  if ('status' in fields) setCell_(sheet, found.match.rowNum, found.table.headerIndex, 'Type', fields.status, found.table.headerRowNum);
  return { ok: true };
}

function addPersonalGoal_(ss, fields) {
  return addGoalRow_(ss, 'Personal Goals', fields);
}

function addTeamGoal_(ss, fields) {
  return addGoalRow_(ss, 'Team Goals', fields);
}

/**
 * Shared by addPersonalGoal_/addTeamGoal_ — same row shape either way.
 * fields.owner accepts a comma-separated list (e.g. "Milena, Kaia") so a
 * team goal can carry more than one name, same as the sheet always could.
 */
function addGoalRow_(ss, sheetName, fields) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { ok: false, error: 'Missing "' + sheetName + '" tab' };
  if (!fields.title || !fields.owner) return { ok: false, error: 'title and owner are required' };
  var cfg = GOAL_TAB_CONFIGS.filter(function(c) { return c.sheetName === sheetName; })[0];
  var table = readSheetRows_(sheet, cfg.columns.goal);
  var id = Utilities.getUuid();
  var row = [];
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

/**
 * Reads a sheet's data, locating the header row by searching for a known
 * column name rather than assuming row 1 — some tabs (e.g. Team Goals,
 * Personal Goals) have title/instruction rows above the real header.
 */
function readSheetRows_(sheet, anchorHeader) {
  var values = sheet.getDataRange().getValues();
  var headerRowIdx = 0;
  if (anchorHeader) {
    for (var i = 0; i < values.length; i++) {
      if (values[i].indexOf(anchorHeader) !== -1) { headerRowIdx = i; break; }
    }
  }
  var headers = values[headerRowIdx] || [];
  var headerIndex = {};
  headers.forEach(function(h, i) { if (h) headerIndex[h] = i; });
  var rows = [];
  for (var r = headerRowIdx + 1; r < values.length; r++) {
    rows.push({ rowNum: r + 1, raw: values[r] });
  }
  return { headerIndex: headerIndex, headerRowNum: headerRowIdx + 1, rows: rows };
}

function cell_(row, headerIndex, name) {
  var idx = headerIndex[name];
  if (idx === undefined) return '';
  var v = row.raw[idx];
  return v === null || v === undefined ? '' : v;
}

/**
 * Like cell_, but for fields that are always meant to be plain text (notes,
 * status, names, titles). Sheets stores time-only entries (e.g. someone
 * typing "1:30") as a Date on its 1899-12-30 epoch, which would otherwise
 * leak through JSON.stringify as a garbage ISO timestamp.
 */
function textCell_(row, headerIndex, name) {
  var v = cell_(row, headerIndex, name);
  if (v instanceof Date) {
    var pattern = v.getFullYear() <= 1899 ? 'h:mm a' : 'yyyy-MM-dd';
    return Utilities.formatDate(v, Session.getScriptTimeZone(), pattern);
  }
  return v;
}

function setCell_(sheet, rowNum, headerIndex, name, value, headerRowNum) {
  var idx = headerIndex[name];
  if (idx === undefined) idx = ensureColumnAt_(sheet, headerRowNum || 1, name, headerIndex);
  sheet.getRange(rowNum, idx + 1).setValue(value);
}

function ensureColumnAt_(sheet, headerRowNum, name, headerIndex) {
  var col = sheet.getLastColumn() + 1;
  sheet.getRange(headerRowNum, col).setValue(name);
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

// ===== Firebase auth (custom token) ========================================
// Firestore has no idea what a "team passcode" is, so the frontend can't
// talk to it directly until it's signed in. This mints a Firebase custom
// token the exact same way the old system gated access — run the existing
// checkPasscode_ check, and on success hand back a token carrying
// {team, role} as custom claims. signInWithCustomToken() on the client
// turns that into a real Firebase ID token, and Firestore Security Rules
// read request.auth.token.team/role directly — no separate per-user
// account, no Admin SDK call, no Cloud Function.

var FIREBASE_TOKEN_AUD =
    'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

function mintToken_(teamKey, view, passcode) {
  if (!TEAMS[teamKey]) return { ok: false, error: 'Unknown team: ' + teamKey };
  if (!checkPasscode_(teamKey, view, passcode)) {
    return { ok: false, error: 'Invalid or missing passcode' };
  }
  var uid = teamKey + '_' + view; // no per-user identity — everyone sharing this passcode shares this uid
  var token = signFirebaseCustomToken_(uid, { team: teamKey, role: view });
  return { ok: true, token: token };
}

function serviceAccount_() {
  var raw = PropertiesService.getScriptProperties().getProperty('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set in Script Properties');
  return JSON.parse(raw);
}

function signFirebaseCustomToken_(uid, claims) {
  var sa = serviceAccount_();
  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: FIREBASE_TOKEN_AUD,
    iat: now,
    exp: now + 3600,
    uid: uid,
    claims: claims,
  };
  var signingInput = base64UrlEncodeString_(JSON.stringify(header)) + '.' +
      base64UrlEncodeString_(JSON.stringify(payload));
  var signatureBytes = Utilities.computeRsaSha256Signature(signingInput, sa.private_key);
  return signingInput + '.' + base64UrlEncodeBytes_(signatureBytes);
}

function base64UrlEncodeString_(s) {
  return base64UrlEncodeBytes_(Utilities.newBlob(s).getBytes());
}

function base64UrlEncodeBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

// ===== Firestore admin access (service account, bypasses Security Rules) ===
// mintToken_ above signs tokens for the FRONTEND — real users, gated by
// Security Rules. This is different: a Google OAuth2 access token for the
// service account itself, used only from Code.gs (migration script, daily
// digest, seeding a team doc) to read/write Firestore directly as an admin.
// Same JWT-bearer mechanics as mintToken_, different audience/scope, and
// cached for its lifetime so a burst of calls doesn't re-mint every time.

var FIRESTORE_ADMIN_SCOPE = 'https://www.googleapis.com/auth/datastore';
var GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';

function adminAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('FIRESTORE_ADMIN_TOKEN');
  if (cached) return cached;

  var sa = serviceAccount_();
  var now = Math.floor(Date.now() / 1000);
  var header = { alg: 'RS256', typ: 'JWT' };
  var payload = {
    iss: sa.client_email,
    scope: FIRESTORE_ADMIN_SCOPE,
    aud: GOOGLE_TOKEN_URI,
    iat: now,
    exp: now + 3600,
  };
  var signingInput = base64UrlEncodeString_(JSON.stringify(header)) + '.' +
      base64UrlEncodeString_(JSON.stringify(payload));
  var signatureBytes = Utilities.computeRsaSha256Signature(signingInput, sa.private_key);
  var jwt = signingInput + '.' + base64UrlEncodeBytes_(signatureBytes);

  var resp = UrlFetchApp.fetch(GOOGLE_TOKEN_URI, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });
  var body = JSON.parse(resp.getContentText());
  if (!body.access_token) throw new Error('Failed to get admin access token: ' + resp.getContentText());

  // Cache for a bit less than its real lifetime so we never hand out one
  // that's about to expire mid-request.
  cache.put('FIRESTORE_ADMIN_TOKEN', body.access_token, Math.min(body.expires_in - 60, 1500));
  return body.access_token;
}

function firestoreBaseUrl_() {
  return 'https://firestore.googleapis.com/v1/projects/' + serviceAccount_().project_id + '/databases/(default)/documents';
}

/** Admin GET of one Firestore document. Returns null if it doesn't exist. */
function firestoreGetDoc_(path) {
  var resp = UrlFetchApp.fetch(firestoreBaseUrl_() + '/' + path, {
    headers: { Authorization: 'Bearer ' + adminAccessToken_() },
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() === 404) return null;
  return JSON.parse(resp.getContentText());
}

/** Admin create-or-replace of one Firestore document at an exact path. */
function firestoreSetDoc_(path, fields) {
  var resp = UrlFetchApp.fetch(firestoreBaseUrl_() + '/' + path, {
    method: 'patch',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + adminAccessToken_() },
    payload: JSON.stringify({ fields: fields }),
    muteHttpExceptions: true,
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Firestore write failed (' + code + '): ' + resp.getContentText());
  return JSON.parse(resp.getContentText());
}

/** Converts a plain JS value into a Firestore REST API typed Value wrapper. */
function firestoreValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return isFinite(v) && Math.floor(v) === v ? { integerValue: String(v) } : { doubleValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(firestoreValue_) } };
  if (typeof v === 'object') return { mapValue: { fields: firestoreFields_(v) } };
  return { stringValue: String(v) };
}

/** Converts a plain JS object into a Firestore REST API `fields` map. */
function firestoreFields_(obj) {
  var fields = {};
  Object.keys(obj).forEach(function(k) { fields[k] = firestoreValue_(obj[k]); });
  return fields;
}

/**
 * Run manually from the editor, once, after TEAMS is populated and
 * FIREBASE_SERVICE_ACCOUNT_JSON is set. Creates/updates the teams/{teamKey}
 * doc for every team — the one Firestore write app users can never make
 * themselves (Security Rules lock it to "if false").
 */
function seedTeamDocs_() {
  var results = [];
  Object.keys(TEAMS).forEach(function(teamKey) {
    var team = TEAMS[teamKey];
    firestoreSetDoc_('teams/' + teamKey, firestoreFields_({
      calendarId: team.calendarId || '',
      mentors: team.mentors || [],
    }));
    results.push(teamKey);
  });
  Logger.log('Seeded team docs: ' + JSON.stringify(results));
  return { ok: true, teams: results };
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
  ensureTab_(ss, VIEWS_TAB, VIEWS_COLUMNS);
  ensureTab_(ss, SUBTASKS_TAB, SUBTASKS_COLUMNS);

  GOAL_TAB_CONFIGS.forEach(function(cfg) {
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (sheet) {
      backfillRowIds_(sheet, cfg.columns.goal);
      backfillPriorityOrder_(sheet, cfg.columns.goal);
    }
  });
  var deadlinesSheet = ss.getSheetByName(DEADLINES_TAB);
  if (deadlinesSheet) backfillRowIds_(deadlinesSheet, 'Event name');
  var notesSheet = ss.getSheetByName(MENTOR_NOTES_TAB);
  if (notesSheet) backfillRowIds_(notesSheet, 'Note');
  var viewsSheet = ss.getSheetByName(VIEWS_TAB);
  if (viewsSheet) backfillRowIds_(viewsSheet, 'Name');
  var subtasksSheet = ss.getSheetByName(SUBTASKS_TAB);
  if (subtasksSheet) backfillRowIds_(subtasksSheet, 'Text');
}

function ensureTab_(ss, name, columns) {
  var sheet = ss.getSheetByName(name);
  if (sheet) return sheet;
  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
  sheet.setFrozenRows(1);
  return sheet;
}

/**
 * Undoes a stray Row ID column from a prior run that mislocated the header
 * row (e.g. because a title/instructions row sat above it): if "Row ID"
 * appears anywhere OTHER than the real header row, that whole column is
 * cleared so backfillRowIds_ can add it correctly. Safe to call repeatedly —
 * a correctly-placed Row ID column is left untouched.
 */
function repairStrayRowIdColumn_(sheet, anchorHeader) {
  var values = sheet.getDataRange().getValues();
  var headerRowIdx = 0;
  if (anchorHeader) {
    for (var i = 0; i < values.length; i++) {
      if (values[i].indexOf(anchorHeader) !== -1) { headerRowIdx = i; break; }
    }
  }
  for (var r = 0; r < values.length; r++) {
    if (r === headerRowIdx) continue;
    var col = values[r].indexOf(ROW_ID_COLUMN);
    if (col !== -1) {
      sheet.getRange(1, col + 1, sheet.getMaxRows(), 1).clearContent();
      return;
    }
  }
}

function backfillRowIds_(sheet, anchorHeader) {
  repairStrayRowIdColumn_(sheet, anchorHeader);
  var table = readSheetRows_(sheet, anchorHeader);
  var idx = table.headerIndex[ROW_ID_COLUMN];
  if (idx === undefined) idx = ensureColumnAt_(sheet, table.headerRowNum, ROW_ID_COLUMN, table.headerIndex);
  table.rows.forEach(function(row) {
    var firstCellHasContent = row.raw.some(function(v) { return v !== '' && v !== null; });
    if (!firstCellHasContent) return;
    var existing = row.raw[idx];
    if (!existing) {
      sheet.getRange(row.rowNum, idx + 1).setValue(Utilities.getUuid());
    }
  });
}

/**
 * Backfills the Priority Order column with each row's current position, for
 * rows that don't have one yet. Unlike Row ID this never needed a repair
 * pass — it's only ever added after the header-row-detection fix, so
 * ensureColumnAt_ places it correctly from the start.
 */
function backfillPriorityOrder_(sheet, anchorHeader) {
  var table = readSheetRows_(sheet, anchorHeader);
  var idx = table.headerIndex[PRIORITY_ORDER_COLUMN];
  if (idx === undefined) idx = ensureColumnAt_(sheet, table.headerRowNum, PRIORITY_ORDER_COLUMN, table.headerIndex);
  var seq = 1;
  table.rows.forEach(function(row) {
    var firstCellHasContent = row.raw.some(function(v) { return v !== '' && v !== null; });
    if (!firstCellHasContent) return;
    var existing = row.raw[idx];
    if (existing === '' || existing === null || existing === undefined) {
      sheet.getRange(row.rowNum, idx + 1).setValue(seq);
    }
    seq++;
  });
}
