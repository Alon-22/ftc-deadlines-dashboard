// kanban.js — Board tab: goals grouped into columns by status, drag a card
// to a new column to change it. Writes go through the same updateGoal
// action every other status change already uses — no backend change.
// Talks to the rest of the app only through window.DB (see app.js).

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    board: document.getElementById('kanban-board'),
    typeFilter: document.getElementById('board-type-filter'),
  };
  if (!el.board) return; // no Board tab on this page

  var COLUMNS = ['Not started', 'Green', 'Yellow', 'Red', 'Done'];
  var currentGoals = [];

  DB.onData(function (data) {
    currentGoals = (data.items || []).filter(function (i) { return i.type === 'goal'; });
    render();
  });

  if (el.typeFilter) el.typeFilter.addEventListener('change', render);

  function normalizedStatus(goal) {
    var s = (goal.status || '').trim();
    var match = COLUMNS.filter(function (c) { return c.toLowerCase() === s.toLowerCase(); })[0];
    return match || 'Not started';
  }

  function filtered() {
    var type = el.typeFilter ? el.typeFilter.value : '';
    if (!type) return currentGoals;
    return currentGoals.filter(function (g) { return g.subtype === type; });
  }

  function render() {
    el.board.innerHTML = '';
    var goals = filtered();

    COLUMNS.forEach(function (status) {
      var colGoals = goals.filter(function (g) { return normalizedStatus(g) === status; });
      el.board.appendChild(buildColumn(status, colGoals));
    });
  }

  function buildColumn(status, goals) {
    var col = document.createElement('div');
    col.className = 'kanban-column status-' + status.toLowerCase().replace(/\s+/g, '-');
    col.dataset.status = status;

    var header = document.createElement('div');
    header.className = 'kanban-column-header';
    header.textContent = status + ' (' + goals.length + ')';
    col.appendChild(header);

    var body = document.createElement('div');
    body.className = 'kanban-column-body';
    if (!goals.length) {
      var empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Nothing here.';
      body.appendChild(empty);
    } else {
      goals.forEach(function (g) { body.appendChild(buildCard(g)); });
    }
    col.appendChild(body);

    return col;
  }

  function buildCard(goal) {
    var card = document.createElement('div');
    card.className = 'kanban-card';
    card.dataset.id = goal.id;

    var title = document.createElement('div');
    title.className = 'kanban-card-title';
    title.textContent = goal.title;
    card.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'kanban-card-meta';
    var bits = [];
    if (goal.owner) bits.push(goal.owner);
    if (goal.group) bits.push(goal.group);
    meta.textContent = bits.join(' · ');
    card.appendChild(meta);

    if (goal.daysLeft !== null && goal.daysLeft !== undefined) {
      var due = document.createElement('div');
      due.className = 'kanban-card-due';
      due.textContent = goal.daysLeft < 0
        ? Math.abs(goal.daysLeft) + 'd overdue'
        : goal.daysLeft + 'd left';
      card.appendChild(due);
    }

    attachDrag(card, goal);
    return card;
  }

  // Whole-card drag, same Pointer Events pattern as gantt.js's bar drag:
  // translate visually during the drag, then on drop find which column
  // the pointer landed in (a coarse "anywhere in the column" target is
  // plenty precise for a board — no within-column ordering to worry
  // about) and write the new status if it changed.
  function attachDrag(card, goal) {
    var dragging = false;
    var startX, startY;

    card.addEventListener('pointerdown', function (e) {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      card.setPointerCapture(e.pointerId);
      card.classList.add('dragging');
    });

    card.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      card.style.transform = 'translate(' + (e.clientX - startX) + 'px,' + (e.clientY - startY) + 'px)';
      highlightColumnUnder(e.clientX, e.clientY);
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      card.classList.remove('dragging');
      card.style.transform = '';
      clearHighlight();

      // Barely any movement = this was a click, not a drag — open the
      // editor instead of trying to find a drop column for it.
      var moved = Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY);
      if (moved < 5) { DB.editItem(goal); return; }

      var target = document.elementFromPoint(e.clientX, e.clientY);
      var col = target && target.closest('.kanban-column');
      if (!col) return;
      var newStatus = col.dataset.status;
      if (newStatus === normalizedStatus(goal)) return;

      var prevStatus = goal.status; // optimistic — revert by hand on failure,
      goal.status = newStatus;      // since onSnapshot only re-fires on a
      render();                     // real Firestore change, not a failed write
      DB.post('updateGoal', goal.id, { status: newStatus }, function (ok) {
        if (!ok) { goal.status = prevStatus; render(); }
      });
    }

    card.addEventListener('pointerup', endDrag);
    card.addEventListener('pointercancel', endDrag);
  }

  function highlightColumnUnder(x, y) {
    clearHighlight();
    var target = document.elementFromPoint(x, y);
    var col = target && target.closest('.kanban-column');
    if (col) col.classList.add('drop-target');
  }

  function clearHighlight() {
    Array.prototype.slice.call(el.board.querySelectorAll('.drop-target')).forEach(function (c) {
      c.classList.remove('drop-target');
    });
  }
})();
