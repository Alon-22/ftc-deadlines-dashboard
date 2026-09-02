// workload.js — Workload tab: open (not-Done) goal count per person, so
// it's easy to spot who's overloaded and who has room. Read-only — no
// writes here. Talks to the rest of the app only through window.DB.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    chart: document.getElementById('workload-chart'),
    list: document.getElementById('workload-list'),
  };
  if (!el.chart && !el.list) return; // no Workload tab on this page

  var currentGoals = [];
  var openExpanded = null; // which person's list is currently expanded

  DB.onData(function (data) {
    currentGoals = (data.items || []).filter(function (i) { return i.type === 'goal'; });
    render();
  });

  function isDone(goal) {
    return (goal.status || '').trim().toLowerCase() === 'done';
  }

  function ownerNames(ownerStr) {
    return (ownerStr || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function byPerson() {
    var open = currentGoals.filter(function (g) { return !isDone(g); });
    var groups = {};
    open.forEach(function (g) {
      ownerNames(g.owner).forEach(function (name) {
        if (!groups[name]) groups[name] = [];
        groups[name].push(g);
      });
    });
    return groups;
  }

  function render() {
    var groups = byPerson();
    var names = Object.keys(groups).sort();

    if (el.chart) {
      if (!names.length || !window.DBCharts) {
        el.chart.innerHTML = names.length ? '' : '<p class="empty-state">No open goals right now.</p>';
      } else {
        window.DBCharts.renderBarChart(el.chart, names.map(function (n) {
          return { label: n, value: groups[n].length };
        }));
      }
    }

    if (el.list) {
      el.list.innerHTML = '';
      names.forEach(function (name) {
        el.list.appendChild(buildPersonRow(name, groups[name]));
      });
    }
  }

  function buildPersonRow(name, goals) {
    var wrap = document.createElement('div');
    wrap.className = 'workload-person';

    var header = document.createElement('button');
    header.type = 'button';
    header.className = 'workload-person-header';
    header.textContent = name + ' — ' + goals.length + (goals.length === 1 ? ' open goal' : ' open goals');
    header.addEventListener('click', function () {
      openExpanded = openExpanded === name ? null : name;
      render();
    });
    wrap.appendChild(header);

    if (openExpanded === name) {
      var list = document.createElement('div');
      list.className = 'card-list';
      goals.forEach(function (g) { list.appendChild(DB.buildCard(g)); });
      wrap.appendChild(list);
    }

    return wrap;
  }
})();
