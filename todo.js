// todo.js — To-Do tab: one printable weekly list per person, split into
// Overdue, Due this week, and Upcoming, with addable/checkable sub-tasks.
// Every sub-task is a row in the new Subtasks sheet tab (added via
// addSubtask, checked off via toggleSubtask) — that tab IS the season-end
// judges record, so nothing here needs a separate "save" step. Talks to
// the rest of the app only through window.DB (see app.js).

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    list: document.getElementById('todo-list'),
    printBtn: document.getElementById('todo-print-btn'),
  };
  if (!el.list) return; // no To-Do tab on this page

  if (el.printBtn) el.printBtn.addEventListener('click', function () { window.print(); });

  DB.onData(function (data) {
    var goals = (data.items || []).filter(function (i) { return i.type === 'goal'; });
    renderTodo(goals, data.subtasks || []);
  });

  function startOfWeek(date) {
    var d = new Date(date);
    d.setHours(0, 0, 0, 0);
    var day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
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

  function weekKey(date) {
    return startOfWeek(date).toISOString().slice(0, 10);
  }

  function isDone(goal) {
    return (goal.status || '').trim().toLowerCase() === 'done';
  }

  function ownerNames(ownerStr) {
    return (ownerStr || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // Sections shown per person, in display order — Overdue first since it's
  // the most urgent, then this week, then everything still further out.
  var SECTIONS = [
    { key: 'overdue', label: 'Overdue', cls: 'urgency-red' },
    { key: 'week', label: 'Due this week', cls: '' },
    { key: 'upcoming', label: 'Upcoming', cls: 'urgency-green' },
  ];

  function renderTodo(goals, subtasks) {
    el.list.innerHTML = '';
    var now = new Date();
    var thisStart = startOfWeek(now);
    var thisEnd = endOfDay(addDays(thisStart, 6));

    var incomplete = goals.filter(function (g) { return !isDone(g) && g.targetDate; });

    var byOwner = {};
    incomplete.forEach(function (g) {
      var t = new Date(g.targetDate);
      var bucket = t < thisStart ? 'overdue' : (t > thisEnd ? 'upcoming' : 'week');
      var names = ownerNames(g.owner);
      if (!names.length) names = ['(unassigned)'];
      names.forEach(function (name) {
        if (!byOwner[name]) byOwner[name] = { overdue: [], week: [], upcoming: [] };
        byOwner[name][bucket].push(g);
      });
    });

    var names = Object.keys(byOwner).sort();
    if (!names.length) {
      el.list.innerHTML = '<p class="empty-state">Nobody has any open goals with a target date yet.</p>';
      return;
    }

    names.forEach(function (name) {
      el.list.appendChild(buildPersonSection(name, byOwner[name], subtasks));
    });
  }

  function buildPersonSection(name, buckets, subtasks) {
    var section = document.createElement('div');
    section.className = 'todo-person';

    var h3 = document.createElement('h3');
    h3.textContent = name;
    section.appendChild(h3);

    SECTIONS.forEach(function (s) {
      var goals = buckets[s.key];
      if (!goals.length) return;
      var heading = document.createElement('h4');
      heading.className = 'todo-section-heading ' + s.cls;
      heading.textContent = s.label;
      section.appendChild(heading);
      goals.forEach(function (goal) {
        section.appendChild(buildGoalBlock(goal, subtasks));
      });
    });

    return section;
  }

  function buildGoalBlock(goal, subtasks) {
    var block = document.createElement('div');
    block.className = 'todo-goal';

    var title = document.createElement('div');
    title.className = 'todo-goal-title';
    title.textContent = goal.title;
    title.title = 'Click to edit';
    title.addEventListener('click', function () { DB.editItem(goal); });
    block.appendChild(title);

    var subList = document.createElement('div');
    subList.className = 'todo-subtasks';
    subtasks
      .filter(function (s) { return s.goalId === goal.id; })
      .forEach(function (s) { subList.appendChild(buildSubtaskRow(s)); });
    block.appendChild(subList);

    var addRow = document.createElement('div');
    addRow.className = 'todo-add-subtask';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Add a sub-task...';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary';
    btn.textContent = 'Add';

    function submit() {
      var text = input.value.trim();
      if (!text) return;
      DB.withPasscode(function () {
        DB.post('addSubtask', null, { goalId: goal.id, owner: goal.owner, weekOf: weekKey(new Date()), text: text }, function (ok) {
          if (ok) { input.value = ''; DB.load(); }
        });
      });
    }

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    addRow.appendChild(input);
    addRow.appendChild(btn);
    block.appendChild(addRow);

    return block;
  }

  function buildSubtaskRow(s) {
    var row = document.createElement('label');
    row.className = 'todo-subtask-row' + (s.done ? ' done' : '');

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.done;
    cb.addEventListener('change', function () {
      DB.withPasscode(function () {
        DB.post('toggleSubtask', s.id, { done: cb.checked }, function (ok) { if (ok) DB.load(); });
      });
    });
    row.appendChild(cb);

    var span = document.createElement('span');
    span.textContent = s.text;
    row.appendChild(span);

    return row;
  }
})();
