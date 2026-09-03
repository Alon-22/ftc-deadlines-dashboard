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
 *   4. Optional: run setupDailyDigest() once to install a daily 7am trigger
 *      that emails each person in the Firestore People directory (added
 *      from the mentor view's People tab) their overdue/due-this-week/
 *      stuck goals. Safe to skip — nothing else depends on it.
 */

// ===== Team registry =====================================================

const TEAMS = {
  MysteryMeat: {
    sheetId: '1xuNGLtx8PPptspuuv8CyQvoVTq1vhuHDQBuU1In-MZY',
    calendarId: 'c_75dae7e7b71d6c86414525f344f9018a0b245cc08756965c47c23fbc47e812f7@group.calendar.google.com',
    mentors: ['Mr. Belkin', 'Zoe'], // exact names as they appear in "Whose goal" / owner columns
    driveFolderId: '0AJC_ts9JONRuUk9PVA', // Shared Drive — uploadPhoto_ creates a subfolder in here, not in My Drive
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
    } else if (params.action === 'uploadPhoto') {
      result = uploadPhoto_(params.team, params.view === 'mentor' ? 'mentor' : 'student', params.passcode, params.fields || {});
    } else if (params.action === 'lookupPartPrice') {
      result = lookupPartPrice_(params.team, params.view === 'mentor' ? 'mentor' : 'student', params.passcode, params.fields || {});
    } else if (params.action === 'sendPurchaseRequestEmail') {
      result = sendPurchaseRequestEmail_(params.team, params.view === 'mentor' ? 'mentor' : 'student', params.passcode, params.fields || {});
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

// ===== Photo uploads (Google Drive) =========================================
// Firebase Storage needs a paid Blaze plan for a new project's default
// bucket — a real cost, not just friction — so photos (portfolio sections,
// engineering notebook entries) go to Drive instead: same free-forever
// story as everything else here. The client sends a small base64 image;
// this drops it in a per-team folder, makes it link-viewable, and hands
// back a URL the client stores as a plain string field on the Firestore
// doc — Code.gs never touches Firestore for this, it's pure Drive work.

function uploadPhoto_(teamKey, view, passcode, fields) {
  var team = TEAMS[teamKey];
  if (!team) return { ok: false, error: 'Unknown team: ' + teamKey };
  if (!checkPasscode_(teamKey, view, passcode)) {
    return { ok: false, error: 'Invalid or missing passcode' };
  }
  if (!fields.base64Data || !fields.filename) {
    return { ok: false, error: 'filename and base64Data are required' };
  }

  var bytes = Utilities.base64Decode(fields.base64Data);
  var blob = Utilities.newBlob(bytes, fields.mimeType || 'image/jpeg', fields.filename);
  var folder = uploadsFolder_(teamKey);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return { ok: true, url: 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1600' };
}

function uploadsFolder_(teamKey) {
  var team = TEAMS[teamKey];
  // Prefer a Shared Drive over My Drive when configured — a folder that
  // lives under one person's account is a single point of failure for a
  // team resource, and Shared Drives are free (no Blaze plan needed).
  var parent = team.driveFolderId ? DriveApp.getFolderById(team.driveFolderId) : DriveApp;
  var name = team.driveFolderId ? 'Dashboard Uploads' : 'FTC Dashboard Uploads - ' + teamKey;
  var existing = parent.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parent.createFolder(name);
}

// ===== Part price lookup (Budget tab "paste a link" auto-fill) =============
// Best-effort only — this fetches the vendor's page server-side (a browser
// can't; the vendor's own CORS policy blocks a cross-origin fetch from our
// frontend) and looks for a title + price the same way search engines do:
// schema.org JSON-LD structured data first (most reliable when present),
// then Open Graph/itemprop meta tags, then last-resort regexes. Vendor name,
// FTC-team discount rate, and tax are all handled client-side (budget.js) —
// this only ever returns what's actually printed on the page.

function lookupPartPrice_(teamKey, view, passcode, fields) {
  var team = TEAMS[teamKey];
  if (!team) return { ok: false, error: 'Unknown team: ' + teamKey };
  if (!checkPasscode_(teamKey, view, passcode)) {
    return { ok: false, error: 'Invalid or missing passcode' };
  }
  var url = fields.url;
  if (!/^https?:\/\//i.test(url || '')) {
    return { ok: false, error: 'Not a valid link' };
  }

  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (resp.getResponseCode() >= 400) {
    return { ok: false, error: 'Could not load that page (' + resp.getResponseCode() + ')' };
  }
  var html = resp.getContentText().slice(0, 400000); // title/price info is always near the top/in <head> — no need to scan a whole huge page
  var info = extractProductInfo_(html);
  return info.price == null
      ? { ok: false, error: 'No price found on that page' }
      : { ok: true, price: info.price, title: info.title || '' };
}

function extractProductInfo_(html) {
  var result = { title: null, price: null };

  var ldMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (var i = 0; i < ldMatches.length && (result.price == null || result.title == null); i++) {
    var jsonText = ldMatches[i].replace(/^[\s\S]*?>/, '').replace(/<\/script>\s*$/i, '');
    try {
      var found = findProductInJson_(JSON.parse(jsonText));
      if (found) {
        if (result.price == null && found.price != null) result.price = found.price;
        if (result.title == null && found.name) result.title = found.name;
      }
    } catch (e) { /* not valid JSON on this page — try the next block, or fall through */ }
  }

  if (result.price == null) {
    var metaMatch = html.match(/<meta[^>]+(?:property|itemprop)=["'](?:product:price:amount|og:price:amount|price)["'][^>]+content=["']([\d.]+)["']/i) ||
        html.match(/<meta[^>]+content=["']([\d.]+)["'][^>]+(?:property|itemprop)=["'](?:product:price:amount|og:price:amount|price)["']/i);
    if (metaMatch) result.price = parseFloat(metaMatch[1]);
  }
  if (result.price == null) {
    var dollarMatch = html.match(/\$\s?(\d{1,5}(?:\.\d{2})?)/);
    if (dollarMatch) result.price = parseFloat(dollarMatch[1]);
  }

  if (result.title == null) {
    var ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (ogTitle) result.title = decodeHtmlEntities_(ogTitle[1]);
  }
  if (result.title == null) {
    var titleTag = html.match(/<title>([^<]+)<\/title>/i);
    if (titleTag) result.title = decodeHtmlEntities_(titleTag[1]).replace(/\s*[-|]\s*[^-|]+$/, '');
  }

  return result;
}

/** Walks a parsed JSON-LD object/array looking for a schema.org Product's name + its Offer's price. */
function findProductInJson_(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) {
      var found = findProductInJson_(node[i]);
      if (found) return found;
    }
    return null;
  }

  var price = null;
  if (node.price != null && !isNaN(parseFloat(node.price))) {
    price = parseFloat(node.price);
  } else if (node.offers) {
    var offerResult = findProductInJson_(node.offers);
    if (offerResult && offerResult.price != null) price = offerResult.price;
  }
  if (price != null) return { name: node.name || null, price: price };

  if (node['@graph']) {
    var fromGraph = findProductInJson_(node['@graph']);
    if (fromGraph) return fromGraph;
  }
  var keys = Object.keys(node);
  for (var k = 0; k < keys.length; k++) {
    var val = node[keys[k]];
    if (val && typeof val === 'object') {
      var fromChild = findProductInJson_(val);
      if (fromChild) return fromChild;
    }
  }
  return null;
}

function decodeHtmlEntities_(s) {
  return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ===== Purchase request email (Budget tab "Submit to coaches") =============
// The client already resolves who "the coaches" are — it cross-references
// the People directory against this team's mentor roster (the "mentors"
// field on the team doc) and builds the subject/body — this endpoint only
// ever does the one thing only Code.gs can do, which is actually send mail.

function sendPurchaseRequestEmail_(teamKey, view, passcode, fields) {
  var team = TEAMS[teamKey];
  if (!team) return { ok: false, error: 'Unknown team: ' + teamKey };
  if (!checkPasscode_(teamKey, view, passcode)) {
    return { ok: false, error: 'Invalid or missing passcode' };
  }
  var to = (fields.to || []).filter(function (addr) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr); }).slice(0, 10);
  if (!to.length) return { ok: false, error: 'No valid recipient email addresses' };
  if (!fields.subject || !fields.body) return { ok: false, error: 'Missing subject or body' };

  MailApp.sendEmail({ to: to.join(','), subject: fields.subject, body: fields.body });
  return { ok: true };
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
 * Admin GET of every document in a collection (paginated internally —
 * these team-scoped collections are small, but this doesn't assume it).
 * Returns [{id, ...plainFields}], used by the daily digest to read goals
 * and people without a real user's Security-Rules-gated session.
 */
function firestoreListDocs_(path) {
  var docs = [];
  var pageToken = null;
  do {
    var url = firestoreBaseUrl_() + '/' + path + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    var resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + adminAccessToken_() },
      muteHttpExceptions: true,
    });
    if (resp.getResponseCode() >= 300) throw new Error('Firestore list failed (' + resp.getResponseCode() + '): ' + resp.getContentText());
    var body = JSON.parse(resp.getContentText());
    (body.documents || []).forEach(function (doc) { docs.push(firestoreParseDoc_(doc)); });
    pageToken = body.nextPageToken || null;
  } while (pageToken);
  return docs;
}

/** Converts a Firestore REST API typed Value wrapper back into a plain JS value. */
function firestoreParseValue_(v) {
  if (!v || v.nullValue !== undefined) return null;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(firestoreParseValue_);
  if (v.mapValue !== undefined) return firestoreParseFields_(v.mapValue.fields || {});
  return null;
}

/** Converts a Firestore REST API `fields` map back into a plain JS object. */
function firestoreParseFields_(fields) {
  var obj = {};
  Object.keys(fields).forEach(function (k) { obj[k] = firestoreParseValue_(fields[k]); });
  return obj;
}

/** Converts one Firestore REST API document into {id, ...plainFields}. */
function firestoreParseDoc_(doc) {
  var id = doc.name.split('/').pop();
  return Object.assign({ id: id }, firestoreParseFields_(doc.fields || {}));
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

/**
 * One-time migration: copies every team's Sheet data into Firestore.
 * Run manually from the editor after seedTeamDocs_. Reuses the same
 * readSheetRows_/cell_/textCell_/toDate_ helpers handleRead_ already uses
 * — same header-row detection, same Date-vs-time-only-cell handling — so
 * nothing gets reparsed differently between the live Sheets backend and
 * this export. Row ID (already a real UUID on every tab except Season
 * Log) becomes the Firestore document ID directly, so every existing
 * cross-reference (Subtasks.goalId -> a goal) survives untouched.
 *
 * Safe to re-run: every write is a set (create-or-replace) keyed by that
 * same Row ID, so running it again just re-syncs the same documents
 * rather than duplicating them — except Season Log, which has no Row ID
 * in the sheet and gets a fresh UUID minted per row on every run, so
 * re-running WOULD duplicate season log entries. Only run it more than
 * once if you're doing a fresh migration before any real cutover.
 */
function migrateToFirestore_() {
  var results = {};
  Object.keys(TEAMS).forEach(function(teamKey) {
    results[teamKey] = migrateTeamToFirestore_(teamKey);
  });
  Logger.log('Migration results: ' + JSON.stringify(results));
  return results;
}

function migrateTeamToFirestore_(teamKey) {
  var team = TEAMS[teamKey];
  var ss = SpreadsheetApp.openById(team.sheetId);
  var mentors = team.mentors || [];

  // Catches any row added since the last setupAllTeams() run.
  setupTeamSheet_(team.sheetId);

  var counts = { goals: 0, deadlines: 0, mentorNotes: 0, subtasks: 0, views: 0, seasonLog: 0 };

  GOAL_TAB_CONFIGS.forEach(function(cfg) {
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet) return;
    var table = readSheetRows_(sheet, cfg.columns.goal);
    table.rows.forEach(function(row) {
      var goalTitle = textCell_(row, table.headerIndex, cfg.columns.goal);
      if (!goalTitle) return;
      var rowId = cell_(row, table.headerIndex, ROW_ID_COLUMN);
      if (!rowId) return;
      var owner = textCell_(row, table.headerIndex, cfg.columns.owner);
      var owners = owner ? owner.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
      var startDate = toDate_(cell_(row, table.headerIndex, cfg.columns.startDate));
      var targetDate = toDate_(cell_(row, table.headerIndex, cfg.columns.targetDate));
      var priorityRaw = cell_(row, table.headerIndex, cfg.columns.priorityOrder);

      firestoreSetDoc_('teams/' + teamKey + '/goals/' + rowId, firestoreFields_({
        title: goalTitle,
        owner: owner,
        owners: owners,
        group: textCell_(row, table.headerIndex, cfg.columns.group),
        subtype: cfg.subtype,
        status: textCell_(row, table.headerIndex, cfg.columns.status),
        notes: textCell_(row, table.headerIndex, cfg.columns.lastUpdate),
        startDate: startDate ? startDate.toISOString() : null,
        targetDate: targetDate ? targetDate.toISOString() : null,
        priorityOrder: priorityRaw === '' ? null : Number(priorityRaw),
        isMentorOwned: cfg.subtype === 'personal' && ownerIsMentor_(owner, mentors),
      }));
      counts.goals++;
    });
  });

  var deadlinesSheet = ss.getSheetByName(DEADLINES_TAB);
  if (deadlinesSheet) {
    var dTable = readSheetRows_(deadlinesSheet, 'Event name');
    dTable.rows.forEach(function(row) {
      var title = textCell_(row, dTable.headerIndex, 'Event name');
      if (!title) return;
      var rowId = cell_(row, dTable.headerIndex, ROW_ID_COLUMN);
      if (!rowId) return;
      var targetDate = toDate_(cell_(row, dTable.headerIndex, 'Date'));
      firestoreSetDoc_('teams/' + teamKey + '/deadlines/' + rowId, firestoreFields_({
        title: title,
        targetDate: targetDate ? targetDate.toISOString() : null,
        eventType: textCell_(row, dTable.headerIndex, 'Type') || 'Other',
        notes: textCell_(row, dTable.headerIndex, 'Notes'),
      }));
      counts.deadlines++;
    });
  }

  var notesSheet = ss.getSheetByName(MENTOR_NOTES_TAB);
  if (notesSheet) {
    var nTable = readSheetRows_(notesSheet, 'Note');
    nTable.rows.forEach(function(row) {
      var note = textCell_(row, nTable.headerIndex, 'Note');
      if (!note) return;
      var rowId = cell_(row, nTable.headerIndex, ROW_ID_COLUMN);
      if (!rowId) return;
      var date = toDate_(cell_(row, nTable.headerIndex, 'Date'));
      firestoreSetDoc_('teams/' + teamKey + '/mentorNotes/' + rowId, firestoreFields_({
        mentor: textCell_(row, nTable.headerIndex, 'Mentor'),
        note: note,
        date: date ? date.toISOString() : new Date().toISOString(),
      }));
      counts.mentorNotes++;
    });
  }

  var subtasksSheet = ss.getSheetByName(SUBTASKS_TAB);
  if (subtasksSheet) {
    var sTable = readSheetRows_(subtasksSheet, 'Text');
    sTable.rows.forEach(function(row) {
      var text = textCell_(row, sTable.headerIndex, 'Text');
      if (!text) return;
      var rowId = cell_(row, sTable.headerIndex, ROW_ID_COLUMN);
      if (!rowId) return;
      var createdAt = toDate_(cell_(row, sTable.headerIndex, 'Created At'));
      var completedAt = toDate_(cell_(row, sTable.headerIndex, 'Completed At'));
      firestoreSetDoc_('teams/' + teamKey + '/subtasks/' + rowId, firestoreFields_({
        goalId: textCell_(row, sTable.headerIndex, 'Goal ID'),
        owner: textCell_(row, sTable.headerIndex, 'Owner'),
        weekOf: textCell_(row, sTable.headerIndex, 'Week Of'),
        text: text,
        done: String(cell_(row, sTable.headerIndex, 'Done')).toUpperCase() === 'TRUE',
        createdAt: createdAt ? createdAt.toISOString() : new Date().toISOString(),
        completedAt: completedAt ? completedAt.toISOString() : null,
      }));
      counts.subtasks++;
    });
  }

  var viewsSheet = ss.getSheetByName(VIEWS_TAB);
  if (viewsSheet) {
    var vTable = readSheetRows_(viewsSheet, 'Name');
    vTable.rows.forEach(function(row) {
      var name = textCell_(row, vTable.headerIndex, 'Name');
      if (!name) return;
      var rowId = cell_(row, vTable.headerIndex, ROW_ID_COLUMN);
      if (!rowId) return;
      var config = {};
      try { config = JSON.parse(textCell_(row, vTable.headerIndex, 'Config')); } catch (err) { config = {}; }
      firestoreSetDoc_('teams/' + teamKey + '/views/' + rowId, firestoreFields_({
        name: name,
        config: config,
        createdBy: textCell_(row, vTable.headerIndex, 'Created By'),
      }));
      counts.views++;
    });
  }

  // No Row ID column here (confirmed: the separate "Gantt chart updater"
  // script that archives Done goals into this tab never added one) — mint
  // a fresh id per row for the Firestore doc.
  var logSheet = ss.getSheetByName(SEASON_LOG_TAB);
  if (logSheet) {
    var lTable = readSheetRows_(logSheet, 'Archived on');
    lTable.rows.forEach(function(row) {
      var title = textCell_(row, lTable.headerIndex, 'Goal');
      if (!title) return;
      var startDate = toDate_(cell_(row, lTable.headerIndex, 'Start date'));
      var targetDate = toDate_(cell_(row, lTable.headerIndex, 'Target date'));
      var finishedOn = toDate_(cell_(row, lTable.headerIndex, 'Finished on'));
      var archivedOn = toDate_(cell_(row, lTable.headerIndex, 'Archived on'));
      var varianceRaw = cell_(row, lTable.headerIndex, 'Early (-) / Late (+)');
      firestoreSetDoc_('teams/' + teamKey + '/seasonLog/' + Utilities.getUuid(), firestoreFields_({
        type: textCell_(row, lTable.headerIndex, 'Type'),
        title: title,
        owner: textCell_(row, lTable.headerIndex, 'Owner'),
        group: textCell_(row, lTable.headerIndex, 'Subteam / skill'),
        startDate: startDate ? startDate.toISOString() : null,
        targetDate: targetDate ? targetDate.toISOString() : null,
        finishedOn: finishedOn ? finishedOn.toISOString() : null,
        varianceDays: varianceRaw === '' ? null : Number(varianceRaw),
        notes: textCell_(row, lTable.headerIndex, 'Notes / who I told'),
        archivedOn: archivedOn ? archivedOn.toISOString() : null,
      }));
      counts.seasonLog++;
    });
  }

  return counts;
}

// ===== Daily digest email ===================================================
// One email per person per team, only when they actually have something to
// act on (overdue, due this week, or self-flagged Red/"stuck") — reads
// Firestore as admin (Security Rules never let a real session list every
// team's goals across the roster) and matches by exact name against the
// People directory, same matching the owner-name text already used
// everywhere else in the app.

/**
 * Run once from the editor (Run menu) to install the daily trigger. Safe
 * to re-run — clears any previous sendDailyDigest_ trigger first so this
 * never ends up with two.
 */
function setupDailyDigest() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyDigest_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyDigest_').timeBased().everyDays(1).atHour(7).create();
}

function sendDailyDigest_() {
  Object.keys(TEAMS).forEach(function (teamKey) {
    var people = firestoreListDocs_('teams/' + teamKey + '/people');
    if (!people.length) return; // no one asked to be emailed

    var goals = firestoreListDocs_('teams/' + teamKey + '/goals')
      .filter(function (g) { return (g.status || '').toLowerCase() !== 'done'; });
    goals.forEach(function (g) { g._daysLeft = digestDaysLeft_(g.targetDate); });

    var byName = {};
    goals.forEach(function (g) {
      (g.owner || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (name) {
        var key = name.toLowerCase();
        if (!byName[key]) byName[key] = [];
        byName[key].push(g);
      });
    });

    people.forEach(function (person) {
      if (!person.email || !person.name) return;
      var mine = byName[person.name.trim().toLowerCase()] || [];
      if (!mine.length) return;

      var overdue = mine.filter(function (g) { return g._daysLeft != null && g._daysLeft < 0; });
      var dueThisWeek = mine.filter(function (g) { return g._daysLeft != null && g._daysLeft >= 0 && g._daysLeft <= 7; });
      var stuck = mine.filter(function (g) { return (g.status || '') === 'Red'; });
      if (!overdue.length && !dueThisWeek.length && !stuck.length) return;

      var body = digestBody_(overdue, dueThisWeek, stuck);
      MailApp.sendEmail(person.email, 'FTC Dashboard: your goals for today', body);
    });
  });
}

function digestDaysLeft_(targetDate) {
  if (!targetDate) return null;
  return Math.ceil((new Date(targetDate).getTime() - Date.now()) / 86400000);
}

function digestBody_(overdue, dueThisWeek, stuck) {
  var lines = [];
  function section(title, list) {
    if (!list.length) return;
    lines.push(title + ':');
    list.forEach(function (g) { lines.push('  - ' + g.title); });
    lines.push('');
  }
  section('Overdue', overdue);
  section('Due this week', dueThisWeek);
  section('Flagged stuck/slipping', stuck);
  lines.push('Open the dashboard to update these.');
  return lines.join('\n');
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
