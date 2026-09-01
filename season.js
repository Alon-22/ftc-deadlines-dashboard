// season.js — Season tab: browsable table over the Sheet's Season Log
// (archived/completed goals), plus a few fixed trend charts on top of it.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    table: document.getElementById('season-table'),
    typeFilter: document.getElementById('season-filter-type'),
    groupFilter: document.getElementById('season-filter-group'),
    chartMonth: document.getElementById('season-chart-month'),
    chartOnTime: document.getElementById('season-chart-ontime'),
    chartSubteam: document.getElementById('season-chart-subteam'),
  };
  if (!el.table) return; // no Season tab on this page

  var seasonLog = [];

  DB.onData(function (data) {
    seasonLog = data.seasonLog || [];
    populateFilterOptions();
    renderTable();
    renderCharts();
  });

  if (el.typeFilter) el.typeFilter.addEventListener('change', renderTable);
  if (el.groupFilter) el.groupFilter.addEventListener('change', renderTable);

  function populateFilterOptions() {
    fillSelect(el.typeFilter, uniqueValues(seasonLog, 'type'));
    fillSelect(el.groupFilter, uniqueValues(seasonLog, 'group'));
  }

  function uniqueValues(list, key) {
    var seen = {};
    var out = [];
    list.forEach(function (item) {
      var v = item[key];
      if (v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    return out.sort();
  }

  function fillSelect(select, values) {
    if (!select) return;
    var current = select.value;
    select.innerHTML = '<option value="">All</option>';
    values.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    });
    if (values.indexOf(current) !== -1) select.value = current;
  }

  function filtered() {
    var type = el.typeFilter ? el.typeFilter.value : '';
    var group = el.groupFilter ? el.groupFilter.value : '';
    return seasonLog.filter(function (item) {
      return (!type || item.type === type) && (!group || item.group === group);
    });
  }

  function renderTable() {
    var rows = filtered();
    el.table.innerHTML = '';
    if (!rows.length) {
      el.table.innerHTML = '<p class="empty-state">No season history yet.</p>';
      return;
    }

    var table = document.createElement('table');
    table.className = 'scoreboard-table season-table';
    var thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Type</th><th>Goal</th><th>Owner</th><th>Subteam</th><th>Finished</th><th>Variance</th><th>Notes</th></tr>';
    table.appendChild(thead);
    var tbody = document.createElement('tbody');

    rows.sort(function (a, b) { return (b.finishedOn || '').localeCompare(a.finishedOn || ''); });
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var variance = r.varianceDays == null ? '—' : (r.varianceDays <= 0 ? Math.abs(r.varianceDays) + 'd early' : r.varianceDays + 'd late');
      tr.innerHTML =
        '<td>' + DB.escapeHtml(r.type || '') + '</td>' +
        '<td>' + DB.escapeHtml(r.title || '') + '</td>' +
        '<td>' + DB.escapeHtml(r.owner || '') + '</td>' +
        '<td>' + DB.escapeHtml(r.group || '') + '</td>' +
        '<td>' + (r.finishedOn ? new Date(r.finishedOn).toLocaleDateString() : '—') + '</td>' +
        '<td>' + variance + '</td>' +
        '<td>' + DB.escapeHtml(r.notes || '') + '</td>';
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    el.table.appendChild(table);
  }

  function renderCharts() {
    if (!window.DBCharts) return;

    if (el.chartMonth) {
      var byMonth = {};
      seasonLog.forEach(function (r) {
        if (!r.finishedOn) return;
        var key = monthKey(new Date(r.finishedOn));
        byMonth[key] = (byMonth[key] || 0) + 1;
      });
      var monthData = Object.keys(byMonth).sort().map(function (k) { return { label: k, value: byMonth[k] }; });
      window.DBCharts.renderBarChart(el.chartMonth, monthData);
    }

    if (el.chartOnTime) {
      var withVariance = seasonLog.filter(function (r) { return r.varianceDays != null; });
      var onTime = withVariance.filter(function (r) { return r.varianceDays <= 0; }).length;
      var late = withVariance.length - onTime;
      window.DBCharts.renderBarChart(el.chartOnTime, [
        { label: 'On time', value: onTime, color: 'var(--green)' },
        { label: 'Late', value: late, color: 'var(--red)' },
      ]);
    }

    if (el.chartSubteam) {
      var bySubteam = {};
      seasonLog.forEach(function (r) {
        var key = r.group || '(none)';
        bySubteam[key] = (bySubteam[key] || 0) + 1;
      });
      var subteamData = Object.keys(bySubteam).sort().map(function (k) { return { label: k, value: bySubteam[k] }; });
      window.DBCharts.renderBarChart(el.chartSubteam, subteamData);
    }
  }

  function monthKey(date) {
    return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }
})();
