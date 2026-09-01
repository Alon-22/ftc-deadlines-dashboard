// checkin.js — Check-In tab: the sheet's own Weekly Check-In / Subteam
// Scoreboard views, recomputed client-side from items[] already in memory.
// Read-only — no backend calls, so it can't drift from what's on screen
// elsewhere and doesn't depend on the sheet's own formula layout.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    scoreboard: document.getElementById('checkin-scoreboard'),
    subteams: document.getElementById('checkin-subteams'),
  };
  if (!el.scoreboard && !el.subteams) return; // no Check-In tab on this page

  var STATUSES = ['Green', 'Yellow', 'Red', 'Not started', 'Done'];

  DB.onData(function (data) {
    var goals = (data.items || []).filter(function (i) { return i.type === 'goal'; });
    if (el.scoreboard) renderScoreboard(goals);
    if (el.subteams) renderSubteams(goals);
  });

  function normalizedStatus(item) {
    var s = (item.status || '').trim();
    var match = STATUSES.filter(function (known) { return known.toLowerCase() === s.toLowerCase(); })[0];
    return match || 'Not started';
  }

  function isOverdue(item) {
    return item.daysLeft != null && item.daysLeft < 0 && normalizedStatus(item) !== 'Done';
  }

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
