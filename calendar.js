// calendar.js — Calendar tab: a full month grid of every goal/deadline
// with a target date, color-coded by urgency, so a crunch week is
// obvious at a glance instead of only showing up as separate countdown
// cards. Click a pill to edit that item (opens app.js's shared modal —
// this file still never talks to Firestore directly). Talks to the rest
// of the app only through window.DB.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    grid: document.getElementById('calendar-grid'),
    monthLabel: document.getElementById('calendar-month-label'),
    prevBtn: document.getElementById('calendar-prev'),
    todayBtn: document.getElementById('calendar-today'),
    nextBtn: document.getElementById('calendar-next'),
  };
  if (!el.grid) return; // no Calendar tab on this page

  var MAX_PER_DAY = 3;
  var currentItems = [];
  var viewDate = new Date(); // any date within the currently-displayed month

  DB.onData(function (data) {
    currentItems = (data.items || []).filter(function (i) { return i.targetDate; });
    render();
  });

  if (el.prevBtn) el.prevBtn.addEventListener('click', function () { shiftMonth(-1); });
  if (el.nextBtn) el.nextBtn.addEventListener('click', function () { shiftMonth(1); });
  if (el.todayBtn) el.todayBtn.addEventListener('click', function () { viewDate = new Date(); render(); });

  function shiftMonth(delta) {
    viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + delta, 1);
    render();
  }

  function dateKey(d) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function render() {
    var year = viewDate.getFullYear();
    var month = viewDate.getMonth();

    if (el.monthLabel) {
      el.monthLabel.textContent = viewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }

    var byDay = {};
    currentItems.forEach(function (item) {
      var d = new Date(item.targetDate);
      var key = dateKey(d);
      if (!byDay[key]) byDay[key] = [];
      byDay[key].push(item);
    });

    var firstOfMonth = new Date(year, month, 1);
    // Grid starts on the Monday on/before the 1st, same week convention checkin.js uses.
    var gridStart = new Date(firstOfMonth);
    var startDow = firstOfMonth.getDay(); // 0 = Sunday
    gridStart.setDate(1 - (startDow === 0 ? 6 : startDow - 1));

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    el.grid.innerHTML = '';
    var table = document.createElement('div');
    table.className = 'calendar-grid';

    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(function (label) {
      var head = document.createElement('div');
      head.className = 'calendar-weekday';
      head.textContent = label;
      table.appendChild(head);
    });

    var cursor = new Date(gridStart);
    for (var week = 0; week < 6; week++) {
      for (var dow = 0; dow < 7; dow++) {
        table.appendChild(buildDayCell(new Date(cursor), month, today, byDay[dateKey(cursor)] || []));
        cursor.setDate(cursor.getDate() + 1);
      }
      // Once a full 6th row would be entirely next month, skip it — most months only need 5.
      if (cursor.getMonth() !== month && cursor > firstOfMonth) break;
    }

    el.grid.appendChild(table);
  }

  function buildDayCell(date, viewMonth, today, items) {
    var cell = document.createElement('div');
    cell.className = 'calendar-day';
    if (date.getMonth() !== viewMonth) cell.classList.add('other-month');
    if (date.getTime() === today.getTime()) cell.classList.add('today');

    var num = document.createElement('div');
    num.className = 'calendar-day-num';
    num.textContent = date.getDate();
    cell.appendChild(num);

    items.slice(0, MAX_PER_DAY).forEach(function (item) {
      var pill = document.createElement('div');
      pill.className = 'calendar-pill urgency-' + DB.urgencyClass(item);
      pill.textContent = item.title;
      pill.title = item.title + (item.owner ? ' — ' + item.owner : '');
      pill.addEventListener('click', function () { DB.editItem(item); });
      cell.appendChild(pill);
    });
    if (items.length > MAX_PER_DAY) {
      var more = document.createElement('div');
      more.className = 'calendar-pill-more';
      more.textContent = '+' + (items.length - MAX_PER_DAY) + ' more';
      cell.appendChild(more);
    }

    return cell;
  }
})();
