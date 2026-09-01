// Shared logic for index.html (student) and mentor.html (mentor).
// Each page sets `window.DASHBOARD_VIEW` to 'student' or 'mentor' before
// loading this file, and includes config/teams.js first.

(function () {
  'use strict';

  var VIEW = window.DASHBOARD_VIEW || 'student';
  var teams = window.TEAMS || [];
  var state = {
    team: null,
    passcode: sessionStorage.getItem('passcode:' + VIEW) || '',
    data: null,
    filterGroup: '',
  };

  var el = {};
  var dataListeners = [];

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheEls();
    initTabs();

    if (!teams.length) {
      el.main.innerHTML = '<p class="empty-state">No teams configured yet — add one to config/teams.js.</p>';
      return;
    }

    teams.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.key;
      opt.textContent = t.label;
      el.teamSelect.appendChild(opt);
    });

    var lastTeam = localStorage.getItem('lastTeam:' + VIEW);
    state.team = teams.some(function (t) { return t.key === lastTeam; }) ? lastTeam : teams[0].key;
    el.teamSelect.value = state.team;
    el.teamSelect.addEventListener('change', function () {
      state.team = el.teamSelect.value;
      localStorage.setItem('lastTeam:' + VIEW, state.team);
      load();
    });

    if (el.addDeadlineForm) el.addDeadlineForm.addEventListener('submit', onAddDeadline);
    if (el.addGoalForm) el.addGoalForm.addEventListener('submit', onAddGoal);
    if (el.addNoteForm) el.addNoteForm.addEventListener('submit', onAddNote);

    if (VIEW === 'mentor' && !state.passcode) {
      showGate();
    } else {
      load();
    }
  }

  function cacheEls() {
    el.main = document.getElementById('main');
    el.teamSelect = document.getElementById('team-select');
    el.deadlinesList = document.getElementById('deadlines-list');
    el.teamGoalsList = document.getElementById('team-goals-list');
    el.personalGoalsList = document.getElementById('personal-goals-list');
    el.mentorNotesList = document.getElementById('mentor-notes-list');
    el.addDeadlineForm = document.getElementById('add-deadline-form');
    el.addGoalForm = document.getElementById('add-goal-form');
    el.addNoteForm = document.getElementById('add-note-form');
    el.gate = document.getElementById('gate');
    el.gateInput = document.getElementById('gate-passcode');
    el.gateSubmit = document.getElementById('gate-submit');
    el.toast = document.getElementById('toast');
    el.tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
    el.tabPanels = Array.prototype.slice.call(document.querySelectorAll('.tab-panel'));
  }

  function initTabs() {
    if (!el.tabButtons.length) return; // page has no tab bar, skip
    el.tabButtons.forEach(function (btn) {
      btn.addEventListener('click', function () { showTab(btn.dataset.tab); });
    });
    var last = localStorage.getItem('lastTab:' + VIEW);
    showTab(el.tabButtons.some(function (b) { return b.dataset.tab === last; }) ? last : el.tabButtons[0].dataset.tab);
  }

  function showTab(name) {
    el.tabButtons.forEach(function (btn) { btn.classList.toggle('active', btn.dataset.tab === name); });
    el.tabPanels.forEach(function (panel) { panel.classList.toggle('active', panel.dataset.tab === name); });
    localStorage.setItem('lastTab:' + VIEW, name);
  }

  function showGate() {
    if (!el.gate) return load(); // page has no gate markup, skip
    el.gate.style.display = 'block';
    el.main.style.display = 'none';
    el.gateSubmit.addEventListener('click', function () {
      state.passcode = el.gateInput.value.trim();
      sessionStorage.setItem('passcode:' + VIEW, state.passcode);
      el.gate.style.display = 'none';
      el.main.style.display = '';
      load();
    });
  }

  function teamConfig() {
    return teams.filter(function (t) { return t.key === state.team; })[0];
  }

  function load() {
    var team = teamConfig();
    if (!team) return;
    var url = team.webAppUrl + '?team=' + encodeURIComponent(state.team) +
        '&view=' + VIEW + '&action=deadlines' +
        (state.passcode ? '&passcode=' + encodeURIComponent(state.passcode) : '');

    setLoading(true);
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (json) {
        setLoading(false);
        if (!json.ok) {
          if (VIEW === 'mentor' && /passcode/i.test(json.error || '')) {
            sessionStorage.removeItem('passcode:' + VIEW);
            state.passcode = '';
            showGate();
            return;
          }
          toast('Error: ' + json.error);
          return;
        }
        state.data = json;
        render();
        dataListeners.forEach(function (fn) { fn(json); });
      })
      .catch(function (err) {
        setLoading(false);
        toast('Could not reach the dashboard backend: ' + err);
      });
  }

  function setLoading(isLoading) {
    if (el.main) el.main.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  }

  // ===== Rendering ===========================================================

  function urgencyClass(item) {
    var status = (item.status || '').toLowerCase();
    if (status === 'done') return 'done';
    if (item.daysLeft === null || item.daysLeft === undefined) return 'green';
    if (item.daysLeft < 0) return 'red';
    if (item.daysLeft <= 7) return 'red';
    if (item.daysLeft <= 21) return 'yellow';
    return 'green';
  }

  function formatCountdown(item) {
    if (item.daysLeft === null || item.daysLeft === undefined) {
      return { days: 'no date set', hours: '' };
    }
    var days = item.daysLeft < 0
      ? Math.abs(item.daysLeft) + 'd overdue'
      : item.daysLeft + (item.daysLeft === 1 ? ' day left' : ' days left');
    var hours = (item.workHoursLeft === null || item.workHoursLeft === undefined)
      ? ''
      : '~' + item.workHoursLeft + ' work ' + (item.workHoursLeft === 1 ? 'hr' : 'hrs') + ' left';
    return { days: days, hours: hours };
  }

  function sortByUrgency(items) {
    return items.slice().sort(function (a, b) {
      var av = a.workHoursLeft !== null && a.workHoursLeft !== undefined ? a.workHoursLeft : a.daysLeft;
      var bv = b.workHoursLeft !== null && b.workHoursLeft !== undefined ? b.workHoursLeft : b.daysLeft;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return av - bv;
    });
  }

  function render() {
    var items = state.data.items || [];
    var deadlines = sortByUrgency(items.filter(function (i) { return i.type === 'deadline'; }));
    var teamGoals = sortByUrgency(items.filter(function (i) { return i.type === 'goal' && i.subtype === 'team'; }));
    var personalGoals = sortByUrgency(items.filter(function (i) { return i.type === 'goal' && i.subtype === 'personal'; }));

    if (el.deadlinesList) renderList(el.deadlinesList, deadlines, 'No competitions or deadlines yet.');
    if (el.teamGoalsList) renderList(el.teamGoalsList, teamGoals, 'No team goals yet.');
    if (el.personalGoalsList) renderList(el.personalGoalsList, personalGoals, 'No personal goals yet.');

    if (el.mentorNotesList) renderNotes(el.mentorNotesList, state.data.mentorNotes || []);
  }

  function renderList(container, items, emptyText) {
    container.innerHTML = '';
    if (!items.length) {
      container.innerHTML = '<p class="empty-state">' + escapeHtml(emptyText) + '</p>';
      return;
    }
    items.forEach(function (item) {
      container.appendChild(buildCard(item));
    });
  }

  function buildCard(item) {
    var urgency = urgencyClass(item);
    var countdown = formatCountdown(item);

    var card = document.createElement('div');
    card.className = 'card urgency-' + urgency;

    var top = document.createElement('div');
    top.className = 'card-top';

    var titleWrap = document.createElement('div');
    var title = document.createElement('p');
    title.className = 'card-title';
    title.textContent = item.title;
    titleWrap.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'card-meta';
    var metaBits = [];
    if (item.owner) metaBits.push(item.owner);
    if (item.group) metaBits.push(item.group);
    if (item.isMentorOwned) metaBits.push('mentor goal');
    meta.textContent = metaBits.join(' · ');
    titleWrap.appendChild(meta);

    if (item.status) {
      var badge = document.createElement('span');
      badge.className = 'badge status-' + item.status.toLowerCase().replace(/\s+/g, '-');
      badge.textContent = item.status;
      titleWrap.appendChild(document.createElement('br'));
      titleWrap.appendChild(badge);
    }

    top.appendChild(titleWrap);

    var countdownEl = document.createElement('div');
    countdownEl.className = 'countdown urgency-' + urgency;
    var daysEl = document.createElement('div');
    daysEl.className = 'days';
    daysEl.textContent = countdown.days;
    countdownEl.appendChild(daysEl);
    if (countdown.hours) {
      var hoursEl = document.createElement('div');
      hoursEl.className = 'hours';
      hoursEl.textContent = countdown.hours;
      countdownEl.appendChild(hoursEl);
    }
    top.appendChild(countdownEl);
    card.appendChild(top);

    if (item.notes) {
      var notesP = document.createElement('div');
      notesP.className = 'card-notes';
      notesP.textContent = item.notes;
      card.appendChild(notesP);
    }

    var actions = document.createElement('div');
    actions.className = 'card-actions';
    var editBtn = document.createElement('button');
    editBtn.className = 'secondary';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () { toggleEdit(card, item); });
    actions.appendChild(editBtn);

    if (item.targetDate) {
      var calBtn = document.createElement('a');
      calBtn.className = 'secondary';
      calBtn.textContent = '📅 Add to my calendar';
      calBtn.href = calendarAddUrl(item);
      calBtn.target = '_blank';
      calBtn.rel = 'noopener';
      actions.appendChild(calBtn);
    }

    card.appendChild(actions);

    return card;
  }

  // Google Calendar's "quick add" template URL — opens in a new tab, the
  // student clicks Save on THEIR OWN calendar. No OAuth, no backend
  // involvement: this never touches the shared team calendar or requires
  // any account access from us.
  function calendarAddUrl(item) {
    var start = new Date(item.targetDate);
    var end = new Date(start.getTime() + 86400000); // Calendar's all-day end date is exclusive
    var params = [
      'action=TEMPLATE',
      'text=' + encodeURIComponent(item.title),
      'dates=' + icsDate(start) + '/' + icsDate(end),
    ];
    if (item.notes) params.push('details=' + encodeURIComponent(item.notes));
    return 'https://calendar.google.com/calendar/render?' + params.join('&');
  }

  function icsDate(d) {
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return '' + d.getFullYear() + mm + dd;
  }

  function toggleEdit(card, item) {
    if (card.querySelector('.card-notes-edit')) return; // already open

    var wrap = document.createElement('div');
    wrap.className = 'card-notes card-notes-edit';

    var statusSelect;
    if (item.type === 'goal') {
      statusSelect = document.createElement('select');
      ['Not started', 'Green', 'Yellow', 'Red', 'Done'].forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        if (s === item.status) opt.selected = true;
        statusSelect.appendChild(opt);
      });
      wrap.appendChild(statusSelect);
    }

    var textarea = document.createElement('textarea');
    textarea.value = item.notes || '';
    textarea.placeholder = 'What moved since last time?';
    wrap.appendChild(textarea);

    var row = document.createElement('div');
    row.className = 'card-actions';
    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () { wrap.remove(); row.remove(); });
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);

    saveBtn.addEventListener('click', function () {
      var fields = { lastUpdate: textarea.value };
      if (statusSelect) fields.status = statusSelect.value;
      var action = item.type === 'deadline' ? 'updateDeadline' : 'updateGoal';
      if (item.type === 'deadline') fields = { notes: textarea.value };
      withPasscode(function () {
        post(action, item.id, fields, function (ok) {
          if (ok) { wrap.remove(); row.remove(); load(); }
        });
      });
    });

    card.appendChild(wrap);
    card.appendChild(row);
  }

  function renderNotes(container, notes) {
    container.innerHTML = '';
    if (!notes.length) {
      container.innerHTML = '<p class="empty-state">No mentor notes yet.</p>';
      return;
    }
    notes.forEach(function (n) {
      var entry = document.createElement('div');
      entry.className = 'note-entry';
      var meta = document.createElement('div');
      meta.className = 'note-meta';
      meta.textContent = (n.mentor || 'Unknown') + ' · ' + (n.date ? new Date(n.date).toLocaleDateString() : '');
      var text = document.createElement('div');
      text.textContent = n.note;
      entry.appendChild(meta);
      entry.appendChild(text);
      container.appendChild(entry);
    });
  }

  // ===== Writes ===============================================================

  function withPasscode(fn) {
    if (state.passcode) return fn();
    var p = window.prompt('Enter the ' + VIEW + ' passcode to save changes:');
    if (p === null) return;
    state.passcode = p.trim();
    sessionStorage.setItem('passcode:' + VIEW, state.passcode);
    fn();
  }

  function post(action, id, fields, cb) {
    var team = teamConfig();
    if (!team) return;
    fetch(team.webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // keeps this a "simple request" for Apps Script's CORS handling
      body: JSON.stringify({ team: state.team, view: VIEW, passcode: state.passcode, action: action, id: id, fields: fields }),
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.ok) {
          if (/passcode/i.test(json.error || '')) {
            sessionStorage.removeItem('passcode:' + VIEW);
            state.passcode = '';
          }
          toast('Error: ' + json.error);
          cb(false);
          return;
        }
        toast('Saved');
        cb(true);
      })
      .catch(function (err) {
        toast('Could not save: ' + err);
        cb(false);
      });
  }

  function onAddDeadline(e) {
    e.preventDefault();
    var form = e.target;
    var fields = {
      title: form.title.value.trim(),
      targetDate: form.targetDate.value,
      subtype: form.eventType.value,
      notes: form.notes.value.trim(),
    };
    if (!fields.title || !fields.targetDate) return toast('Event name and date are required');
    withPasscode(function () {
      post('addDeadline', null, fields, function (ok) {
        if (ok) { form.reset(); load(); }
      });
    });
  }

  function onAddGoal(e) {
    e.preventDefault();
    var form = e.target;
    var fields = {
      title: form.title.value.trim(),
      owner: form.owner.value.trim(),
      group: form.group.value.trim(),
      targetDate: form.targetDate.value,
    };
    if (!fields.title || !fields.owner) return toast('Goal and your name are required');
    withPasscode(function () {
      post('addPersonalGoal', null, fields, function (ok) {
        if (ok) { form.reset(); load(); }
      });
    });
  }

  function onAddNote(e) {
    e.preventDefault();
    var form = e.target;
    var fields = { mentor: form.mentor.value.trim(), note: form.note.value.trim() };
    if (!fields.mentor || !fields.note) return toast('Your name and a note are required');
    withPasscode(function () {
      post('addMentorNote', null, fields, function (ok) {
        if (ok) { form.note.value = ''; load(); }
      });
    });
  }

  // ===== Misc ==================================================================

  var toastTimer;
  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 3000);
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ===== Shared surface for gantt.js / checkin.js / season.js / metrics.js ====
  // Each of those files is a separate <script> (no bundler), so they reach
  // the state/helpers here through this one namespace object rather than
  // duplicating fetch/passcode/toast logic.
  window.DB = {
    view: VIEW,
    state: state,
    teamConfig: teamConfig,
    withPasscode: withPasscode,
    load: load,
    post: post,
    toast: toast,
    escapeHtml: escapeHtml,
    urgencyClass: urgencyClass,
    // Registers fn(data) to run after every successful load() (including
    // the first one) — the simplest way for a tab to stay in sync without
    // its own fetch logic. Data volume here is a few dozen rows, so every
    // registered tab just recomputes in full each time; no incremental
    // update complexity needed.
    onData: function (fn) {
      dataListeners.push(fn);
      if (state.data) fn(state.data);
    },
  };
})();
