// checkin.js — Check-In tab: "what needs doing" buckets (due this week, due
// next week, overdue, completed-but-not-yet-archived) built from items[]
// already in memory and editable in place via the same card component the
// Deadlines tab uses, plus the sheet's own Weekly Check-In / Subteam
// Scoreboard views recomputed client-side. No backend calls of its own —
// edits go through the existing updateGoal/updateDeadline actions, so
// nothing here needed a Code.gs change.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    scoreboard: document.getElementById('checkin-scoreboard'),
    subteams: document.getElementById('checkin-subteams'),
    dueThisWeek: document.getElementById('checkin-due-this-week'),
    dueNextWeek: document.getElementById('checkin-due-next-week'),
    overdue: document.getElementById('checkin-overdue'),
    completed: document.getElementById('checkin-completed'),
    recentArchived: document.getElementById('checkin-recent-archived'),
  };
  var hasAny = Object.keys(el).some(function (k) { return el[k]; });
  if (!hasAny) return; // no Check-In tab on this page

  var STATUSES = ['Green', 'Yellow', 'Red', 'Not started', 'Done'];

  DB.onData(function (data) {
    var items = data.items || [];
    var goals = items.filter(function (i) { return i.type === 'goal'; });
    if (el.scoreboard) renderScoreboard(goals);
    if (el.subteams) renderSubteams(goals);

    if (el.dueThisWeek || el.dueNextWeek || el.overdue || el.completed) {
      var buckets = computeBuckets(items);
      if (el.dueThisWeek) renderBucket(el.dueThisWeek, buckets.dueThisWeek, 'Nothing due this week.');
      if (el.dueNextWeek) renderBucket(el.dueNextWeek, buckets.dueNextWeek, 'Nothing due next week.');
      if (el.overdue) renderBucket(el.overdue, buckets.overdue, 'Nothing overdue.');
      if (el.completed) renderBucket(el.completed, buckets.completed, 'Nothing completed yet.');
    }

    if (el.recentArchived) renderRecentArchived(el.recentArchived, data.seasonLog || []);
  });

  function normalizedStatus(item) {
    var s = (item.status || '').trim();
    var match = STATUSES.filter(function (known) { return known.toLowerCase() === s.toLowerCase(); })[0];
    return match || 'Not started';
  }

  function isOverdue(item) {
    return item.daysLeft != null && item.daysLeft < 0 && normalizedStatus(item) !== 'Done';
  }

  // ===== Due this week / next week / overdue / completed =====================

  function startOfWeek(date) {
    var d = new Date(date);
    d.setHours(0, 0, 0, 0);
    var day = d.getDay(); // 0 = Sunday
    d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day)); // back up to Monday
    return d;
  }

  function addDays(date, n) {
    var d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function endOfDay(date) {
    var d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  /**
   * Buckets every item (goals AND deadlines — both carry a targetDate) by
   * this calendar week / next calendar week / overdue, plus goals with
   * status Done into "completed." Overdue takes priority over the week
   * buckets so an early-in-the-week item that's already past due doesn't
   * show up twice.
   */
  function computeBuckets(items) {
    var now = new Date();
    var thisStart = startOfWeek(now);
    var thisEnd = endOfDay(addDays(thisStart, 6));
    var nextStart = addDays(thisStart, 7);
    var nextEnd = endOfDay(addDays(thisStart, 13));

    var dueThisWeek = [], dueNextWeek = [], overdue = [], completed = [];
    items.forEach(function (item) {
      if (item.type === 'goal' && normalizedStatus(item) === 'Done') {
        completed.push(item);
        return;
      }
      if (!item.targetDate) return;
      if (isOverdue(item)) { overdue.push(item); return; }
      var t = new Date(item.targetDate);
      if (t >= thisStart && t <= thisEnd) dueThisWeek.push(item);
      else if (t >= nextStart && t <= nextEnd) dueNextWeek.push(item);
    });

    [dueThisWeek, dueNextWeek, overdue, completed].forEach(function (list) {
      list.sort(function (a, b) { return (a.daysLeft == null ? 0 : a.daysLeft) - (b.daysLeft == null ? 0 : b.daysLeft); });
    });

    return { dueThisWeek: dueThisWeek, dueNextWeek: dueNextWeek, overdue: overdue, completed: completed };
  }

  function renderBucket(container, items, emptyText) {
    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML = '<p class="empty-state">' + DB.escapeHtml(emptyText) + '</p>';
      return;
    }
    items.forEach(function (item) { container.appendChild(DB.buildCard(item)); });
  }

  // ===== Recently archived (Season Log) — read-only, no edit path exists ======
  // for rows the sheet has already swept out of the live goal tabs.

  function renderRecentArchived(container, seasonLog) {
    var now = new Date();
    var start = startOfWeek(now);
    var end = endOfDay(addDays(start, 6));
    var recent = seasonLog.filter(function (r) {
      if (!r.finishedOn) return false;
      var d = new Date(r.finishedOn);
      return d >= start && d <= end;
    });

    container.innerHTML = '';
    if (!recent.length) {
      container.innerHTML = '<p class="empty-state">Nothing archived this week.</p>';
      return;
    }
    recent.forEach(function (r) {
      var entry = document.createElement('div');
      entry.className = 'note-entry';
      var meta = document.createElement('div');
      meta.className = 'note-meta';
      meta.textContent = (r.owner || '') + (r.group ? ' · ' + r.group : '') + ' · finished ' +
        (r.finishedOn ? new Date(r.finishedOn).toLocaleDateString() : '');
      var title = document.createElement('div');
      title.textContent = r.title;
      entry.appendChild(title);
      entry.appendChild(meta);
      container.appendChild(entry);
    });
  }

  // ===== Scoreboard / subteam breakdown (unchanged) ===========================

  function renderScoreboard(goals) {
    var team = goals.filter(function (g) { return g.subtype === 'team'; });
    var personal = goals.filter(function (g) { return g.subtype === 'personal'; });

    var rows = STATUSES.concat(['Overdue']).map(function (status) {
      var countIn = function (list) {
        return status === 'Overdue'
          ? list.filter(isOverdue).length
          : list.filter(function (g) { return normalizedStatus(g) === status; }).length;
      };
      return { status: status, team: countIn(team), personal: countIn(personal) };
    });

    var table = document.createElement('table');
    table.className = 'scoreboard-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Status</th><th>Team</th><th>Personal</th><th>Total</th></tr>';
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.className = 'status-row-' + r.status.toLowerCase().replace(/\s+/g, '-');
      tr.innerHTML = '<td>' + DB.escapeHtml(r.status) + '</td><td>' + r.team + '</td><td>' + r.personal + '</td><td>' + (r.team + r.personal) + '</td>';
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    el.scoreboard.innerHTML = '';
    el.scoreboard.appendChild(table);
  }

  function renderSubteams(goals) {
    var groups = {};
    goals.forEach(function (g) {
      var key = g.group || '(no subteam)';
      if (!groups[key]) groups[key] = [];
      groups[key].push(g);
    });

    var table = document.createElement('table');
    table.className = 'scoreboard-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Subteam</th><th>Open now</th><th>On track</th><th>Needs attention</th><th>Finished</th><th>% done</th></tr>';
    table.appendChild(thead);
    var tbody = document.createElement('tbody');

    Object.keys(groups).sort().forEach(function (key) {
      var list = groups[key];
      var done = list.filter(function (g) { return normalizedStatus(g) === 'Done'; }).length;
      var onTrack = list.filter(function (g) { return normalizedStatus(g) === 'Green'; }).length;
      var needsAttention = list.filter(function (g) {
        var s = normalizedStatus(g);
        return s === 'Yellow' || s === 'Red' || s === 'Not started';
      }).length;
      var openNow = list.length - done;
      var pctDone = list.length ? Math.round((done / list.length) * 100) : 0;

      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + DB.escapeHtml(key) + '</td><td>' + openNow + '</td><td>' + onTrack +
        '</td><td>' + needsAttention + '</td><td>' + done + '</td><td>' + pctDone + '%</td>';
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    el.subteams.innerHTML = '';
    el.subteams.appendChild(table);
  }
})();
