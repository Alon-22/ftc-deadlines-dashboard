// gantt.js — Timeline tab: date-scaled Gantt bars (drag horizontally to
// reschedule) plus separate Priority lists (drag vertically, or use the
// up/down buttons on touch, to set a manual order independent of dates).
// Talks to the rest of the app only through window.DB (see app.js).

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    trackTeam: document.getElementById('gantt-track-team'),
    trackPersonal: document.getElementById('gantt-track-personal'),
    teamPriority: document.getElementById('priority-list-team'),
    personalPriority: document.getElementById('priority-list-personal'),
    ownerFilter: document.getElementById('timeline-owner-filter'),
  };
  var hasAnyEl = Object.keys(el).some(function (k) { return el[k]; });
  if (!hasAnyEl) return; // no Timeline tab on this page

  var MS_PER_DAY = 86400000;
  var currentGoals = []; // last full (unfiltered) goals list, kept in sync so drag handlers can re-render without a refetch

  DB.onData(function (data) {
    currentGoals = (data.items || []).filter(function (i) { return i.type === 'goal'; });
    populateOwnerFilter();
    renderAll();
  });

  if (el.ownerFilter) el.ownerFilter.addEventListener('change', renderAll);

  function ownerNames(ownerStr) {
    return (ownerStr || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function populateOwnerFilter() {
    if (!el.ownerFilter) return;
    var seen = {};
    currentGoals.forEach(function (g) { ownerNames(g.owner).forEach(function (n) { seen[n] = true; }); });
    var names = Object.keys(seen).sort();
    var current = el.ownerFilter.value;
    el.ownerFilter.innerHTML = '<option value="">All people</option>';
    names.forEach(function (n) {
      var opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      el.ownerFilter.appendChild(opt);
    });
    if (names.indexOf(current) !== -1) el.ownerFilter.value = current;
  }

  function selectedOwner() {
    return el.ownerFilter ? el.ownerFilter.value : '';
  }

  function filterByOwner(goals) {
    var sel = selectedOwner();
    if (!sel) return goals;
    return goals.filter(function (g) { return ownerNames(g.owner).indexOf(sel) !== -1; });
  }

  function renderAll() {
    var goals = filterByOwner(currentGoals);
    var filtered = !!selectedOwner();
    if (el.trackTeam) renderGantt(el.trackTeam, goals.filter(function (g) { return g.subtype === 'team'; }));
    if (el.trackPersonal) renderGantt(el.trackPersonal, goals.filter(function (g) { return g.subtype === 'personal'; }));
    if (el.teamPriority) renderPriorityList(el.teamPriority, goals.filter(function (g) { return g.subtype === 'team'; }), 'Team Goals', filtered);
    if (el.personalPriority) renderPriorityList(el.personalPriority, goals.filter(function (g) { return g.subtype === 'personal'; }), 'Personal Goals', filtered);
  }

  // ===== Gantt bars ============================================================

  function renderGantt(container, goals) {
    container.innerHTML = '';
    var withDates = goals.filter(function (g) { return g.targetDate; });
    if (!withDates.length) {
      container.innerHTML = '<p class="empty-state">No dated goals yet.</p>';
      return;
    }
    var sorted = sortForDisplay(withDates);
    var scale = computeScale(sorted);
    // Available width is whatever the scrollable pane gets, not the label
    // column — the label column is a separate, non-scrolling flex sibling,
    // so bars and gridlines never sit underneath the row labels.
    var scrollWidth = Math.max((container.clientWidth || 600) - 150, 400);
    var totalDays = Math.max(1, (scale.maxDate - scale.minDate) / MS_PER_DAY);
    var pixelsPerDay = Math.max(4, scrollWidth / totalDays);
    var fullWidth = pixelsPerDay * totalDays;

    var chart = document.createElement('div');
    chart.className = 'gantt-chart';

    var labels = document.createElement('div');
    labels.className = 'gantt-labels';
    var spacer = document.createElement('div');
    spacer.className = 'gantt-labels-spacer';
    labels.appendChild(spacer);
    sorted.forEach(function (goal) {
      var label = document.createElement('div');
      label.className = 'gantt-row-label';
      label.textContent = goal.title + (goal.owner ? ' · ' + goal.owner : '');
      label.title = label.textContent;
      labels.appendChild(label);
    });
    chart.appendChild(labels);

    var scrollInner = document.createElement('div');
    scrollInner.className = 'gantt-scroll-inner';
    var track = document.createElement('div');
    track.className = 'gantt-track';
    track.style.width = fullWidth + 'px';
    track.appendChild(buildGridlines(scale, pixelsPerDay, totalDays));
    track.appendChild(buildTodayLine(scale, pixelsPerDay));
    sorted.forEach(function (goal) { track.appendChild(buildGanttRow(goal, scale, pixelsPerDay)); });
    scrollInner.appendChild(track);
    chart.appendChild(scrollInner);

    container.appendChild(chart);
  }

  function sortForDisplay(goals) {
    return goals.slice().sort(function (a, b) {
      if (a.priorityOrder != null && b.priorityOrder != null) return a.priorityOrder - b.priorityOrder;
      if (a.priorityOrder != null) return -1;
      if (b.priorityOrder != null) return 1;
      return new Date(a.targetDate) - new Date(b.targetDate);
    });
  }

  function computeScale(goals) {
    var now = new Date();
    var starts = goals.map(function (g) { return new Date(g.startDate || g.targetDate); }).concat([now]);
    var targets = goals.map(function (g) { return new Date(g.targetDate); });
    var minDate = new Date(Math.min.apply(null, starts.map(function (d) { return d.getTime(); })));
    var maxTime = Math.max.apply(null, targets.map(function (d) { return d.getTime(); }));
    return { minDate: minDate, maxDate: new Date(maxTime + 3 * MS_PER_DAY) };
  }

  function dayOffset(scale, date) {
    return (date.getTime() - scale.minDate.getTime()) / MS_PER_DAY;
  }

  function buildGridlines(scale, pixelsPerDay, totalDays) {
    var wrap = document.createElement('div');
    wrap.className = 'gantt-gridlines';
    var stepDays = totalDays <= 90 ? 7 : totalDays <= 365 ? 30 : 90;
    var cursor = new Date(scale.minDate);
    cursor.setHours(0, 0, 0, 0);
    var guard = 0;
    while (cursor <= scale.maxDate && guard < 200) {
      var x = dayOffset(scale, cursor) * pixelsPerDay;
      var line = document.createElement('div');
      line.className = 'gantt-gridline';
      line.style.left = x + 'px';
      var label = document.createElement('span');
      label.textContent = formatShortDate(cursor);
      line.appendChild(label);
      wrap.appendChild(line);
      cursor = new Date(cursor.getTime() + stepDays * MS_PER_DAY);
      guard++;
    }
    return wrap;
  }

  function buildTodayLine(scale, pixelsPerDay) {
    var line = document.createElement('div');
    line.className = 'gantt-today-line';
    line.style.left = (dayOffset(scale, new Date()) * pixelsPerDay) + 'px';
    return line;
  }

  function buildGanttRow(goal, scale, pixelsPerDay) {
    var row = document.createElement('div');
    row.className = 'gantt-row-track';

    var start = new Date(goal.startDate || goal.targetDate);
    var target = new Date(goal.targetDate);
    var left = dayOffset(scale, start) * pixelsPerDay;
    var width = Math.max(10, (dayOffset(scale, target) - dayOffset(scale, start)) * pixelsPerDay);

    var bar = document.createElement('div');
    bar.className = 'gantt-bar urgency-' + DB.urgencyClass(goal);
    bar.style.left = left + 'px';
    bar.style.width = width + 'px';
    bar.title = goal.title;

    var tip = document.createElement('span');
    tip.className = 'gantt-bar-tip';
    bar.appendChild(tip);

    if (goal.startDate) attachDragToReschedule(bar, goal, pixelsPerDay, tip);
    row.appendChild(bar);
    return row;
  }

  function attachDragToReschedule(bar, goal, pixelsPerDay, tip) {
    var dragState = null;

    bar.addEventListener('pointerdown', function (e) {
      bar.setPointerCapture(e.pointerId);
      dragState = { startX: e.clientX, deltaDays: 0 };
      bar.classList.add('dragging');
    });

    bar.addEventListener('pointermove', function (e) {
      if (!dragState) return;
      dragState.deltaDays = Math.round((e.clientX - dragState.startX) / pixelsPerDay);
      bar.style.transform = 'translateX(' + (dragState.deltaDays * pixelsPerDay) + 'px)';
      var newStart = addDays(new Date(goal.startDate), dragState.deltaDays);
      var newTarget = addDays(new Date(goal.targetDate), dragState.deltaDays);
      tip.textContent = formatShortDate(newStart) + ' → ' + formatShortDate(newTarget);
      tip.classList.add('show');
    });

    function endDrag() {
      if (!dragState) return;
      var deltaDays = dragState.deltaDays;
      dragState = null;
      bar.classList.remove('dragging');
      bar.style.transform = '';
      tip.classList.remove('show');
      if (!deltaDays) return;

      var prevStart = goal.startDate;
      var prevTarget = goal.targetDate;
      goal.startDate = addDays(new Date(goal.startDate), deltaDays).toISOString();
      goal.targetDate = addDays(new Date(goal.targetDate), deltaDays).toISOString();
      renderAll(); // optimistic: reflect the new position immediately

      DB.withPasscode(function () {
        DB.post('updateGoal', goal.id, { startDate: goal.startDate, targetDate: goal.targetDate }, function (ok) {
          if (!ok) {
            goal.startDate = prevStart;
            goal.targetDate = prevTarget;
            renderAll();
          }
        });
      });
    }

    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
  }

  function addDays(date, n) { return new Date(date.getTime() + n * MS_PER_DAY); }
  function formatShortDate(d) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }

  // ===== Priority reorder lists ================================================

  function renderPriorityList(container, goals, sheetName, filtered) {
    container.innerHTML = '';
    if (filtered) {
      var note = document.createElement('p');
      note.className = 'card-meta';
      note.textContent = 'Clear the "All people" filter to reorder — priority numbers are shared across everyone on this tab.';
      container.appendChild(note);
    }
    if (!goals.length) {
      container.appendChild(emptyState('Nothing to prioritize yet.'));
      return;
    }
    var sorted = sortForDisplay(goals);
    var list = document.createElement('div');
    list.className = 'priority-list';

    sorted.forEach(function (goal, i) {
      var row = document.createElement('div');
      row.className = 'priority-row';
      row.dataset.id = goal.id;

      var handle = document.createElement('span');
      handle.className = 'priority-handle';
      handle.textContent = '⠿'; // braille-pattern "grip" glyph, no icon font needed
      row.appendChild(handle);

      var label = document.createElement('span');
      label.className = 'priority-label';
      label.textContent = goal.title;
      row.appendChild(label);

      var buttons = document.createElement('div');
      buttons.className = 'priority-buttons';
      var upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'secondary';
      upBtn.textContent = '↑';
      upBtn.disabled = filtered || i === 0;
      upBtn.addEventListener('click', function () { moveAndSave(sorted, i, i - 1, sheetName); });
      var downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'secondary';
      downBtn.textContent = '↓';
      downBtn.disabled = filtered || i === sorted.length - 1;
      downBtn.addEventListener('click', function () { moveAndSave(sorted, i, i + 1, sheetName); });
      buttons.appendChild(upBtn);
      buttons.appendChild(downBtn);
      row.appendChild(buttons);

      if (!filtered) attachRowDrag(row, handle, list, sorted, sheetName);
      else handle.style.visibility = 'hidden';
      list.appendChild(row);
    });

    container.appendChild(list);
  }

  function emptyState(text) {
    var p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = text;
    return p;
  }

  function moveAndSave(sorted, fromIndex, toIndex, sheetName) {
    if (toIndex < 0 || toIndex >= sorted.length) return;
    var item = sorted.splice(fromIndex, 1)[0];
    sorted.splice(toIndex, 0, item);
    saveOrder(sorted, sheetName);
    renderAll();
  }

  function saveOrder(orderedGoals, sheetName) {
    var order = orderedGoals.map(function (g) { return g.id; });
    orderedGoals.forEach(function (g, i) { g.priorityOrder = i + 1; });
    DB.withPasscode(function () {
      DB.post('reorderGoals', null, { sheetName: sheetName, order: order }, function () {});
    });
  }

  function attachRowDrag(row, handle, list, sorted, sheetName) {
    var dragging = false;

    handle.addEventListener('pointerdown', function (e) {
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      row.classList.add('dragging');
    });

    handle.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var target = document.elementFromPoint(e.clientX, e.clientY);
      var targetRow = target && target.closest('.priority-row');
      if (!targetRow || targetRow === row) return;
      var rows = Array.prototype.slice.call(list.children);
      var fromIndex = rows.indexOf(row);
      var toIndex = rows.indexOf(targetRow);
      if (fromIndex === -1 || toIndex === -1) return;
      if (fromIndex < toIndex) list.insertBefore(row, targetRow.nextSibling);
      else list.insertBefore(row, targetRow);
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      row.classList.remove('dragging');
      var rows = Array.prototype.slice.call(list.children);
      var newOrder = rows.map(function (r) {
        return sorted.filter(function (g) { return g.id === r.dataset.id; })[0];
      }).filter(Boolean);
      saveOrder(newOrder, sheetName);
      renderAll();
    }

    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }
})();
