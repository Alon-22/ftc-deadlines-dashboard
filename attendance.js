// attendance.js — Attendance tab: a simple per-meeting check-in log. Each
// check-in is one Firestore doc ({name, date}), grouped by date in the log
// (most recent first). Both roles can check in and remove an entry — same
// open-collaboration trust level as parts/deadlines. Talks to the rest of
// the app only through window.DB.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    form: document.getElementById('add-attendance-form'),
    nameSelect: document.getElementById('attendance-name'),
    nameOther: document.getElementById('attendance-name-other'),
    dateInput: document.getElementById('attendance-date'),
    log: document.getElementById('attendance-log'),
  };
  if (!el.log && !el.form) return; // no Attendance tab on this page

  if (el.dateInput && !el.dateInput.value) el.dateInput.value = todayIso_();

  DB.onData(function (data) {
    if (el.nameSelect) fillNames_(data.people || []);
    if (el.log) renderLog_(data.attendance || []);
  });

  function todayIso_() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  // Names come from the People directory (the same roster the
  // Organizations tab's "Students" panel manages) — falls back to "Other"
  // for anyone not added there yet.
  function fillNames_(people) {
    var current = el.nameSelect.value;
    el.nameSelect.innerHTML = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select your name…';
    el.nameSelect.appendChild(placeholder);
    people.slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); }).forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      el.nameSelect.appendChild(opt);
    });
    var otherOpt = document.createElement('option');
    otherOpt.value = '__other__';
    otherOpt.textContent = 'Other (type below)…';
    el.nameSelect.appendChild(otherOpt);
    if (current && (people.some(function (p) { return p.name === current; }) || current === '__other__')) {
      el.nameSelect.value = current;
    }
  }

  function renderLog_(records) {
    el.log.innerHTML = '';
    if (!records.length) {
      el.log.innerHTML = '<p class="empty-state">No attendance recorded yet.</p>';
      return;
    }
    var byDate = {};
    records.forEach(function (r) {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    });
    Object.keys(byDate).sort().reverse().forEach(function (date) {
      var entries = byDate[date];
      var group = document.createElement('div');
      group.className = 'attendance-day';

      var heading = document.createElement('h3');
      heading.textContent = formatDate_(date) + ' — ' + entries.length + (entries.length === 1 ? ' person' : ' people');
      group.appendChild(heading);

      var list = document.createElement('div');
      list.className = 'attendance-day-names';
      entries.slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); }).forEach(function (r) {
        var row = document.createElement('div');
        row.className = 'attendance-name-row';
        var span = document.createElement('span');
        span.textContent = r.name;
        row.appendChild(span);
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'secondary';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', function () {
          DB.post('deleteAttendance', r.id, {}, function () {});
        });
        row.appendChild(removeBtn);
        list.appendChild(row);
      });
      group.appendChild(list);
      el.log.appendChild(group);
    });
  }

  function formatDate_(iso) {
    var d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  if (el.nameSelect && el.nameOther) {
    el.nameSelect.addEventListener('change', function () {
      var isOther = el.nameSelect.value === '__other__';
      el.nameOther.style.display = isOther ? '' : 'none';
      if (isOther) el.nameOther.focus();
    });
  }

  if (el.form) {
    el.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = el.nameSelect.value === '__other__' ? el.nameOther.value.trim() : el.nameSelect.value;
      var date = el.dateInput.value || todayIso_();
      if (!name) return;
      var already = (DB.state.data.attendance || []).some(function (r) { return r.name === name && r.date === date; });
      if (already) { DB.toast(name + ' is already checked in for that date.'); return; }
      DB.post('checkIn', null, { name: name, date: date }, function (ok) {
        if (ok) {
          el.nameSelect.value = '';
          el.nameOther.value = '';
          el.nameOther.style.display = 'none';
        }
      });
    });
  }
})();
