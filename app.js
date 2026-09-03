// Shared logic for index.html (student) and mentor.html (mentor).
// Each page sets `window.DASHBOARD_VIEW` to 'student' or 'mentor' before
// loading this file, and includes config/teams.js + config/firebase.js
// + the Firebase compat SDK scripts first.
//
// Data layer: Firestore, read via onSnapshot (live sync) and written via
// the Firebase SDK directly from the browser — Apps Script is only still
// involved for one call, minting a signed custom token (see mintToken_ in
// apps-script/Code.gs) after checking the team's passcode, exactly the way
// it used to gate every read/write. Firestore Security Rules enforce the
// rest (student vs. mentor, which collections each can touch).
//
// Every other file (gantt.js/checkin.js/season.js/metrics.js/todo.js) only
// ever touches window.DB — state.data, post(), onData() — so none of them
// needed to change for this migration; only what's inside this file did.

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
  var db = null;
  var auth = null;
  var unsubscribers = []; // active onSnapshot listeners for the current team, torn down on team switch
  var teamMentors = [];   // current team's mentor names, for computing isMentorOwned on write
  var latestGoals = [];
  var latestDeadlines = [];

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    cacheEls();
    initTabs();

    if (!teams.length) {
      el.main.innerHTML = '<p class="empty-state">No teams configured yet — add one to config/teams.js.</p>';
      return;
    }

    var app = firebase.initializeApp(window.FIREBASE_CONFIG);
    auth = app.auth();
    db = app.firestore();

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
      switchTeam();
    });

    if (el.addDeadlineForm) el.addDeadlineForm.addEventListener('submit', onAddDeadline);
    if (el.addGoalForm) el.addGoalForm.addEventListener('submit', onAddGoal);
    if (el.addTeamGoalForm) el.addTeamGoalForm.addEventListener('submit', onAddTeamGoal);
    if (el.addNoteForm) el.addNoteForm.addEventListener('submit', onAddNote);
    if (el.addGoalOwner) el.addGoalOwner.addEventListener('change', function () { toggleOther(el.addGoalOwner, el.addGoalOwnerOther); });
    if (el.addGoalGroup) el.addGoalGroup.addEventListener('change', function () { toggleOther(el.addGoalGroup, el.addGoalGroupOther); });
    if (el.addTeamGoalGroup) el.addTeamGoalGroup.addEventListener('change', function () { toggleOther(el.addTeamGoalGroup, el.addTeamGoalGroupOther); });

    if (VIEW === 'mentor' && !state.passcode) {
      showGate();
    } else {
      switchTeam();
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
    el.addGoalOwner = document.getElementById('add-goal-owner');
    el.addGoalOwnerOther = document.getElementById('add-goal-owner-other');
    el.addGoalGroup = document.getElementById('add-goal-group');
    el.addGoalGroupOther = document.getElementById('add-goal-group-other');
    el.addTeamGoalForm = document.getElementById('add-team-goal-form');
    el.addTeamGoalOwnerPicker = document.getElementById('add-team-goal-owner-picker');
    el.addTeamGoalOwnerOther = document.getElementById('add-team-goal-owner-other');
    el.addTeamGoalGroup = document.getElementById('add-team-goal-group');
    el.addTeamGoalGroupOther = document.getElementById('add-team-goal-group-other');
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
    // Gantt, the Kanban board, and the calendar grid all want more width than the card tabs do
    el.main.classList.toggle('wide', name === 'timeline' || name === 'board' || name === 'calendar');
    localStorage.setItem('lastTab:' + VIEW, name);
  }

  function showGate() {
    if (!el.gate) return switchTeam(); // page has no gate markup, skip
    el.gate.style.display = 'block';
    el.main.style.display = 'none';
    el.gateSubmit.addEventListener('click', function () {
      var passcode = el.gateInput.value.trim();
      setLoading(true);
      ensureSignedIn(passcode, function (err) {
        setLoading(false);
        if (err) { toast('Error: ' + err); return; }
        el.gate.style.display = 'none';
        el.main.style.display = '';
        subscribeToTeam();
      });
    });
  }

  function teamConfig() {
    return teams.filter(function (t) { return t.key === state.team; })[0];
  }

  // ===== Auth (mint a custom token via Apps Script, then sign in) ============

  function mintToken_(passcode, cb) {
    var team = teamConfig();
    if (!team) return cb(null, 'No team selected');
    var url = team.webAppUrl + '?action=mintToken&team=' + encodeURIComponent(state.team) +
        '&view=' + VIEW + '&passcode=' + encodeURIComponent(passcode || '');
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.ok) return cb(null, json.error);
        cb(json.token, null);
      })
      .catch(function (err) { cb(null, String(err)); });
  }

  function ensureSignedIn(passcode, cb) {
    mintToken_(passcode, function (token, err) {
      if (!token) return cb(err || 'Could not sign in');
      auth.signInWithCustomToken(token)
        .then(function () {
          state.passcode = passcode || '';
          sessionStorage.setItem('passcode:' + VIEW, state.passcode);
          cb(null);
        })
        .catch(function (e) { cb(e.message); });
    });
  }

  // ===== Photo uploads (Drive, via Apps Script) ===============================
  // Firestore docs only ever store the resulting Drive URL string — the
  // actual bytes never touch Firestore (Storage needs the paid Blaze plan).
  // Resize client-side first: a phone photo straight off a camera can be
  // several MB, and Apps Script's doPost body has a real size ceiling.

  function resizeImageToBase64_(file, cb) {
    var reader = new FileReader();
    reader.onerror = function () { cb(null, null, 'Could not read file'); };
    reader.onload = function () {
      var img = new Image();
      img.onerror = function () { cb(null, null, 'Could not decode image'); };
      img.onload = function () {
        var maxEdge = 1600;
        var scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        cb(dataUrl.split(',')[1], 'image/jpeg', null);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function uploadPhoto(file, cb) {
    var team = teamConfig();
    if (!team) return cb(null, 'No team selected');
    resizeImageToBase64_(file, function (base64Data, mimeType, err) {
      if (err) return cb(null, err);
      fetch(team.webAppUrl, {
        method: 'POST',
        body: JSON.stringify({
          action: 'uploadPhoto',
          team: state.team,
          view: VIEW,
          passcode: state.passcode,
          fields: { filename: file.name || 'photo.jpg', mimeType: mimeType, base64Data: base64Data },
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (json) {
          if (!json.ok) return cb(null, json.error);
          cb(json.url, null);
        })
        .catch(function (err2) { cb(null, String(err2)); });
    });
  }

  // Student view has no gate UI — try the cached (often empty) passcode
  // silently first, matching how student reads were always open before.
  // Only fall back to a prompt if that mint is actually rejected (a
  // student passcode has been configured for this team).
  function switchTeam() {
    unsubscribers.forEach(function (unsub) { unsub(); });
    unsubscribers = [];
    latestGoals = [];
    latestDeadlines = [];
    state.data = null;

    setLoading(true);
    (auth.currentUser ? auth.signOut() : Promise.resolve()).then(function () {
      ensureSignedIn(state.passcode, function (err) {
        if (err) {
          setLoading(false);
          if (VIEW === 'student') {
            var p = window.prompt('Enter the student passcode to continue:');
            if (p === null) return;
            ensureSignedIn(p.trim(), function (err2) {
              if (err2) return toast('Error: ' + err2);
              subscribeToTeam();
            });
          } else {
            sessionStorage.removeItem('passcode:' + VIEW);
            state.passcode = '';
            showGate();
          }
          return;
        }
        subscribeToTeam();
      });
    });
  }

  function subscribeToTeam() {
    var team = teamConfig();
    if (!team) return;
    var teamRef = db.collection('teams').doc(state.team);

    teamRef.get().then(function (doc) {
      teamMentors = (doc.exists && doc.data().mentors) || [];
    });

    // Firestore can only allow a collection-wide list query when the rule's
    // condition is provable from the query itself — an unconstrained query
    // can't be checked against each doc's isMentorOwned field the way a
    // single-doc read can, so the student view adds the matching where()
    // clause itself rather than relying on the rule to filter results.
    var goalsQuery = teamRef.collection('goals');
    if (VIEW === 'student') goalsQuery = goalsQuery.where('isMentorOwned', '==', false);
    unsubscribers.push(goalsQuery.onSnapshot(function (snap) {
      latestGoals = snap.docs.map(function (d) { return goalDocToItem_(d); });
      recomputeAndRender();
    }, onSnapshotError_));

    unsubscribers.push(teamRef.collection('deadlines').onSnapshot(function (snap) {
      latestDeadlines = snap.docs.map(function (d) { return deadlineDocToItem_(d); });
      recomputeAndRender();
    }, onSnapshotError_));

    unsubscribers.push(teamRef.collection('subtasks').onSnapshot(function (snap) {
      ensureData_().subtasks = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      recomputeAndRender();
    }, onSnapshotError_));

    unsubscribers.push(teamRef.collection('comments').onSnapshot(function (snap) {
      ensureData_().comments = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      recomputeAndRender();
    }, onSnapshotError_));

    unsubscribers.push(teamRef.collection('engineeringNotebook').onSnapshot(function (snap) {
      var entries = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      entries.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
      ensureData_().notebook = entries;
      recomputeAndRender();
    }, onSnapshotError_));

    unsubscribers.push(teamRef.collection('checklistItems').onSnapshot(function (snap) {
      ensureData_().checklistItems = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      recomputeAndRender();
    }, onSnapshotError_));

    if (VIEW === 'mentor') {
      unsubscribers.push(teamRef.collection('people').onSnapshot(function (snap) {
        var people = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        people.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
        ensureData_().people = people;
        recomputeAndRender();
      }, onSnapshotError_));
    }

    unsubscribers.push(teamRef.collection('views').onSnapshot(function (snap) {
      ensureData_().views = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      recomputeAndRender();
    }, onSnapshotError_));

    unsubscribers.push(teamRef.collection('seasonLog').onSnapshot(function (snap) {
      ensureData_().seasonLog = snap.docs.map(function (d) { return d.data(); });
      recomputeAndRender();
    }, onSnapshotError_));

    if (VIEW === 'mentor') {
      unsubscribers.push(teamRef.collection('mentorNotes').onSnapshot(function (snap) {
        var notes = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        notes.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
        ensureData_().mentorNotes = notes;
        recomputeAndRender();
      }, onSnapshotError_));
    }

    setLoading(false);
  }

  function onSnapshotError_(err) {
    setLoading(false);
    toast('Could not reach the dashboard: ' + err.message);
  }

  function ensureData_() {
    if (!state.data) state.data = { items: [], seasonLog: [], views: [], subtasks: [], mentorNotes: [], comments: [], notebook: [], checklistItems: [], people: [] };
    return state.data;
  }

  function recomputeAndRender() {
    var data = ensureData_();
    data.items = latestGoals.concat(latestDeadlines);
    data.generatedAt = new Date().toISOString();
    render();
    dataListeners.forEach(function (fn) { fn(data); });
  }

  // ===== Firestore doc <-> the items[] shape every tab already expects =====

  function goalDocToItem_(doc) {
    var g = doc.data();
    var targetDate = g.targetDate ? new Date(g.targetDate) : null;
    return {
      type: 'goal',
      subtype: g.subtype,
      id: doc.id,
      title: g.title,
      owner: g.owner || '',
      group: g.group || '',
      startDate: g.startDate || null,
      targetDate: g.targetDate || null,
      status: g.status || '',
      notes: g.notes || '',
      link: g.link || '',
      blockedBy: g.blockedBy || '',
      repeats: g.repeats || 'none',
      priorityOrder: g.priorityOrder == null ? null : g.priorityOrder,
      daysLeft: daysLeft_(targetDate),
      workHoursLeft: g.workHoursLeft == null ? null : g.workHoursLeft,
      isMentorOwned: !!g.isMentorOwned,
    };
  }

  function deadlineDocToItem_(doc) {
    var d = doc.data();
    var targetDate = d.targetDate ? new Date(d.targetDate) : null;
    return {
      type: 'deadline',
      subtype: d.eventType || 'Other',
      id: doc.id,
      title: d.title,
      owner: '',
      group: '',
      targetDate: d.targetDate || null,
      status: '',
      notes: d.notes || '',
      daysLeft: daysLeft_(targetDate),
      workHoursLeft: d.workHoursLeft == null ? null : d.workHoursLeft,
      isMentorOwned: false,
    };
  }

  function daysLeft_(targetDate) {
    if (!targetDate) return null;
    var ms = targetDate.getTime() - Date.now();
    return Math.ceil(ms / 86400000);
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
    populateAddGoalOptions(items);
  }

  // Dropdowns for the "add a new goal" forms are built from names/subteams
  // already seen in the data, so picking one is the fast path and typing a
  // brand new one (via "Other") stays possible without a backend change.
  function populateAddGoalOptions(items) {
    var owners = {};
    var groups = {};
    items.forEach(function (i) {
      (i.owner || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (n) { owners[n] = true; });
      if (i.group) groups[i.group] = true;
    });
    var ownerNames = Object.keys(owners).sort();
    var groupNames = Object.keys(groups).sort();

    if (el.addGoalOwner) fillSelect(el.addGoalOwner, ownerNames, 'Select your name…');
    if (el.addGoalGroup) fillSelect(el.addGoalGroup, groupNames, 'Select subteam / skill area…');
    if (el.addTeamGoalOwnerPicker) fillOwnerPicker(el.addTeamGoalOwnerPicker, ownerNames);
    if (el.addTeamGoalGroup) fillSelect(el.addTeamGoalGroup, groupNames, 'Select subteam…');
  }

  // Team goals can have more than one owner, so this is a picker of
  // checkboxes (chips) rather than a single-select dropdown. Re-rendering
  // on every update preserves whatever's currently checked.
  function fillOwnerPicker(container, names) {
    var checked = {};
    Array.prototype.slice.call(container.querySelectorAll('input[type=checkbox]:checked')).forEach(function (cb) { checked[cb.value] = true; });
    container.innerHTML = '';
    if (!names.length) {
      var empty = document.createElement('span');
      empty.className = 'owner-picker-empty';
      empty.textContent = 'No names yet — add one below.';
      container.appendChild(empty);
      return;
    }
    names.forEach(function (name) {
      var label = document.createElement('label');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = name;
      if (checked[name]) {
        cb.checked = true;
        label.classList.add('checked');
      }
      cb.addEventListener('change', function () { label.classList.toggle('checked', cb.checked); });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(name));
      container.appendChild(label);
    });
  }

  function fillSelect(select, values, placeholder) {
    var current = select.value;
    select.innerHTML = '';
    var placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = placeholder;
    select.appendChild(placeholderOpt);
    values.forEach(function (v) {
      var opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    });
    var otherOpt = document.createElement('option');
    otherOpt.value = '__other__';
    otherOpt.textContent = 'Other (type below)…';
    select.appendChild(otherOpt);
    if (current && (values.indexOf(current) !== -1 || current === '__other__')) select.value = current;
  }

  function toggleOther(select, otherInput) {
    var isOther = select.value === '__other__';
    otherInput.style.display = isOther ? '' : 'none';
    if (isOther) otherInput.focus();
    else otherInput.value = '';
  }

  function resolveOwnerGroup() {
    var owner = el.addGoalOwner
      ? (el.addGoalOwner.value === '__other__' ? el.addGoalOwnerOther.value.trim() : el.addGoalOwner.value)
      : '';
    var group = el.addGoalGroup
      ? (el.addGoalGroup.value === '__other__' ? el.addGoalGroupOther.value.trim() : el.addGoalGroup.value)
      : '';
    return { owner: owner, group: group };
  }

  // Team goals: owner is every checked chip plus whatever's typed in the
  // "add another name" box (comma-separated), joined the same way the
  // sheet already stored multiple names (e.g. "Milena, Kaia").
  function resolveTeamOwnerGroup() {
    var checkedNames = el.addTeamGoalOwnerPicker
      ? Array.prototype.slice.call(el.addTeamGoalOwnerPicker.querySelectorAll('input[type=checkbox]:checked')).map(function (cb) { return cb.value; })
      : [];
    var otherNames = el.addTeamGoalOwnerOther
      ? el.addTeamGoalOwnerOther.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
      : [];
    var owner = checkedNames.concat(otherNames).join(', ');
    var group = el.addTeamGoalGroup
      ? (el.addTeamGoalGroup.value === '__other__' ? el.addTeamGoalGroupOther.value.trim() : el.addTeamGoalGroup.value)
      : '';
    return { owner: owner, group: group };
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

    var blocker = blockingGoal_(item);
    if (blocker) {
      var blockedBadge = document.createElement('span');
      blockedBadge.className = 'badge blocked-badge';
      blockedBadge.textContent = '🔒 Blocked by: ' + blocker.title;
      titleWrap.appendChild(document.createElement('br'));
      titleWrap.appendChild(blockedBadge);
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

    if (item.link) {
      var linkP = document.createElement('div');
      linkP.className = 'card-notes';
      var linkA = document.createElement('a');
      linkA.href = item.link;
      linkA.target = '_blank';
      linkA.rel = 'noopener';
      linkA.textContent = '🔗 ' + fileLinkLabel(item.link);
      linkP.appendChild(linkA);
      card.appendChild(linkP);
    }

    var actions = document.createElement('div');
    actions.className = 'card-actions';
    var editBtn = document.createElement('button');
    editBtn.className = 'secondary';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () { toggleEdit(card, item); });
    actions.appendChild(editBtn);

    if (item.type === 'goal') {
      var commentCount = commentsFor(item.id).length;
      var commentBtn = document.createElement('button');
      commentBtn.className = 'secondary';
      commentBtn.textContent = '💬 ' + (commentCount || 'Comment');
      commentBtn.addEventListener('click', function () { toggleComments(card, item); });
      actions.appendChild(commentBtn);
    }

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

  function fileLinkLabel(url) {
    try {
      var host = new URL(url).hostname.replace(/^www\./, '');
      return host;
    } catch (e) {
      return 'View file';
    }
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

    var statusSelect, linkInput;
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

    if (item.type === 'goal') {
      linkInput = document.createElement('input');
      linkInput.type = 'text';
      linkInput.value = item.link || '';
      linkInput.placeholder = 'Link to CAD/design file/doc (optional)';
      wrap.appendChild(linkInput);
    }

    var blockedBySelect, repeatsSelect;
    if (item.type === 'goal') {
      var depRow = document.createElement('div');
      depRow.className = 'row';

      blockedBySelect = document.createElement('select');
      var noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'Not blocked by anything';
      blockedBySelect.appendChild(noneOpt);
      (state.data.items || []).filter(function (i) { return i.type === 'goal' && i.id !== item.id; })
        .sort(function (a, b) { return a.title.localeCompare(b.title); })
        .forEach(function (g) {
          var opt = document.createElement('option');
          opt.value = g.id;
          opt.textContent = 'Blocked by: ' + g.title;
          if (g.id === item.blockedBy) opt.selected = true;
          blockedBySelect.appendChild(opt);
        });
      depRow.appendChild(blockedBySelect);

      repeatsSelect = document.createElement('select');
      [['none', 'Does not repeat'], ['weekly', 'Repeats weekly'], ['biweekly', 'Repeats every 2 weeks'], ['monthly', 'Repeats monthly']]
        .forEach(function (pair) {
          var opt = document.createElement('option');
          opt.value = pair[0];
          opt.textContent = pair[1];
          if (pair[0] === (item.repeats || 'none')) opt.selected = true;
          repeatsSelect.appendChild(opt);
        });
      depRow.appendChild(repeatsSelect);

      wrap.appendChild(depRow);
    }

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
      if (linkInput) fields.link = linkInput.value.trim();
      if (blockedBySelect) fields.blockedBy = blockedBySelect.value;
      if (repeatsSelect) fields.repeats = repeatsSelect.value;
      var action = item.type === 'deadline' ? 'updateDeadline' : 'updateGoal';
      if (item.type === 'deadline') fields = { notes: textarea.value };
      post(action, item.id, fields, function (ok) {
        if (ok) { wrap.remove(); row.remove(); }
      });
    });

    card.appendChild(wrap);
    card.appendChild(row);
  }

  // Returns the blocking goal only while it's still open — once it's Done
  // the dependency is satisfied, so the badge disappears on its own without
  // needing to clear blockedBy anywhere.
  function blockingGoal_(item) {
    if (!item.blockedBy) return null;
    var blocker = (state.data.items || []).filter(function (i) { return i.id === item.blockedBy && i.type === 'goal'; })[0];
    return (blocker && blocker.status !== 'Done') ? blocker : null;
  }

  // ===== Comments (threaded under a goal) =====================================

  function commentsFor(goalId) {
    var all = (state.data && state.data.comments) || [];
    return all.filter(function (c) { return c.goalId === goalId; });
  }

  function toggleComments(card, item) {
    var existing = card.querySelector('.comments-thread');
    if (existing) { existing.remove(); return; }

    var wrap = document.createElement('div');
    wrap.className = 'comments-thread';

    var list = document.createElement('div');
    renderCommentList(list, commentsFor(item.id));
    wrap.appendChild(list);

    var form = document.createElement('div');
    form.className = 'card-actions comments-add';
    var authorInput = document.createElement('input');
    authorInput.type = 'text';
    authorInput.placeholder = 'Your name';
    var textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.placeholder = 'Add a comment…';
    var sendBtn = document.createElement('button');
    sendBtn.textContent = 'Post';
    sendBtn.addEventListener('click', function () {
      var author = authorInput.value.trim();
      var text = textInput.value.trim();
      if (!author || !text) return toast('Name and a comment are required');
      post('addComment', null, { goalId: item.id, author: author, text: text }, function (ok) {
        if (ok) { textInput.value = ''; }
      });
    });
    form.appendChild(authorInput);
    form.appendChild(textInput);
    form.appendChild(sendBtn);
    wrap.appendChild(form);

    card.appendChild(wrap);
  }

  function renderCommentList(container, comments) {
    container.innerHTML = '';
    if (!comments.length) {
      container.innerHTML = '<p class="empty-state">No comments yet.</p>';
      return;
    }
    comments.slice().sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); })
      .forEach(function (c) {
        var entry = document.createElement('div');
        entry.className = 'note-entry';
        var meta = document.createElement('div');
        meta.className = 'note-meta';
        meta.textContent = (c.author || 'Unknown') + ' · ' + (c.createdAt ? new Date(c.createdAt).toLocaleString() : '');
        var text = document.createElement('div');
        text.textContent = c.text;
        entry.appendChild(meta);
        entry.appendChild(text);
        container.appendChild(entry);
      });
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
  // Every write goes straight to Firestore from here — the passcode gate
  // already happened once (ensureSignedIn, at load or team switch); the
  // signed-in session's custom claims are what Security Rules check on
  // every write from here on, not a per-call passcode.

  function withPasscode(fn) {
    fn(); // kept for gantt.js/todo.js/metrics.js call sites — already signed in by the time any write happens
  }

  function teamRef_() {
    return db.collection('teams').doc(state.team);
  }

  // A recurring goal (repeats != 'none') spawns a fresh, Not-started copy of
  // itself the moment it's marked Done — same title/owner/subteam, target
  // date advanced by the interval, notes and blocker cleared since those
  // belonged to the finished cycle, not the next one.
  function spawnNextRecurrence_(goal) {
    var base = goal.targetDate ? new Date(goal.targetDate) : new Date();
    var next = addInterval_(base, goal.repeats);
    return teamRef_().collection('goals').add({
      subtype: goal.subtype,
      title: goal.title,
      owner: goal.owner || '',
      group: goal.group || '',
      status: 'Not started',
      notes: '',
      link: goal.link || '',
      blockedBy: '',
      repeats: goal.repeats,
      targetDate: next.toISOString(),
      isMentorOwned: !!goal.isMentorOwned,
    });
  }

  function addInterval_(date, repeats) {
    var d = new Date(date);
    if (repeats === 'weekly') d.setDate(d.getDate() + 7);
    else if (repeats === 'biweekly') d.setDate(d.getDate() + 14);
    else if (repeats === 'monthly') d.setMonth(d.getMonth() + 1);
    return d;
  }

  function ownerNames_(ownerStr) {
    return (ownerStr || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function post(action, id, fields, cb) {
    var handler = WRITE_HANDLERS[action];
    if (!handler) { toast('Unknown action: ' + action); return cb(false); }
    handler(id, fields || {})
      .then(function () { toast('Saved'); cb(true); })
      .catch(function (err) { toast('Could not save: ' + err.message); cb(false); });
  }

  var WRITE_HANDLERS = {
    updateGoal: function (id, fields) {
      var patch = {};
      if ('status' in fields) patch.status = fields.status;
      if ('lastUpdate' in fields) patch.notes = fields.lastUpdate;
      if ('link' in fields) patch.link = fields.link;
      if ('blockedBy' in fields) patch.blockedBy = fields.blockedBy;
      if ('repeats' in fields) patch.repeats = fields.repeats;
      if ('startDate' in fields) patch.startDate = new Date(fields.startDate).toISOString();
      if ('targetDate' in fields) patch.targetDate = new Date(fields.targetDate).toISOString();

      var existing = (state.data.items || []).filter(function (i) { return i.id === id && i.type === 'goal'; })[0];
      var justCompletedRecurring = existing && existing.status !== 'Done' && patch.status === 'Done' &&
        existing.repeats && existing.repeats !== 'none';

      return teamRef_().collection('goals').doc(id).update(patch).then(function () {
        if (justCompletedRecurring) return spawnNextRecurrence_(existing);
      });
    },

    updateDeadline: function (id, fields) {
      var patch = {};
      if ('notes' in fields) patch.notes = fields.notes;
      return teamRef_().collection('deadlines').doc(id).update(patch);
    },

    addDeadline: function (id, fields) {
      return teamRef_().collection('deadlines').add({
        title: fields.title,
        targetDate: new Date(fields.targetDate).toISOString(),
        eventType: fields.subtype || 'Other',
        notes: fields.notes || '',
      });
    },

    addPersonalGoal: function (id, fields) {
      var owners = ownerNames_(fields.owner);
      return teamRef_().collection('goals').add({
        title: fields.title,
        owner: fields.owner,
        owners: owners,
        group: fields.group || '',
        subtype: 'personal',
        status: 'Not started',
        notes: '',
        startDate: new Date().toISOString(),
        targetDate: fields.targetDate ? new Date(fields.targetDate).toISOString() : null,
        priorityOrder: null,
        isMentorOwned: owners.some(function (n) { return teamMentors.indexOf(n) !== -1; }),
      });
    },

    addTeamGoal: function (id, fields) {
      var owners = ownerNames_(fields.owner);
      return teamRef_().collection('goals').add({
        title: fields.title,
        owner: fields.owner,
        owners: owners,
        group: fields.group || '',
        subtype: 'team',
        status: 'Not started',
        notes: '',
        startDate: new Date().toISOString(),
        targetDate: fields.targetDate ? new Date(fields.targetDate).toISOString() : null,
        priorityOrder: null,
        isMentorOwned: false,
      });
    },

    addMentorNote: function (id, fields) {
      return teamRef_().collection('mentorNotes').add({
        mentor: fields.mentor,
        note: fields.note,
        date: new Date().toISOString(),
      });
    },

    addComment: function (id, fields) {
      return teamRef_().collection('comments').add({
        goalId: fields.goalId,
        author: fields.author,
        text: fields.text,
        createdAt: new Date().toISOString(),
      });
    },

    reorderGoals: function (id, fields) {
      var subtype = fields.sheetName === 'Team Goals' ? 'team' : 'personal';
      var batch = db.batch();
      var goalsColl = teamRef_().collection('goals');
      fields.order.forEach(function (goalId, i) {
        batch.update(goalsColl.doc(goalId), { priorityOrder: i + 1 });
      });
      return batch.commit().then(function () {
        // subtype isn't used server-side (rules don't need it), it's only
        // here for readers of this code — reorder is scoped to whichever
        // ids were passed in, already filtered to one subtype by gantt.js.
        void subtype;
      });
    },

    addSubtask: function (id, fields) {
      return teamRef_().collection('subtasks').add({
        goalId: fields.goalId,
        owner: fields.owner || '',
        weekOf: fields.weekOf || '',
        text: fields.text,
        done: false,
        createdAt: new Date().toISOString(),
        completedAt: null,
      });
    },

    toggleSubtask: function (id, fields) {
      return teamRef_().collection('subtasks').doc(id).update({
        done: !!fields.done,
        completedAt: fields.done ? new Date().toISOString() : null,
      });
    },

    deleteSubtask: function (id) {
      return teamRef_().collection('subtasks').doc(id).delete();
    },

    saveView: function (id, fields) {
      var payload = { name: fields.name, config: fields.config, createdBy: fields.createdBy || '' };
      if (id) return teamRef_().collection('views').doc(id).set(payload);
      return teamRef_().collection('views').add(payload);
    },

    deleteView: function (id) {
      return teamRef_().collection('views').doc(id).delete();
    },

    addNotebookEntry: function (id, fields) {
      return teamRef_().collection('engineeringNotebook').add({
        author: fields.author,
        title: fields.title,
        body: fields.body,
        photos: fields.photos || [],
        date: fields.date || new Date().toISOString().slice(0, 10),
        createdAt: new Date().toISOString(),
      });
    },

    deleteNotebookEntry: function (id) {
      return teamRef_().collection('engineeringNotebook').doc(id).delete();
    },

    // checklistItems is shared by the Portfolio tab today and Phase 4's
    // competition-day/awards checklists later — fields.checklistName is
    // what separates one checklist's items from another's.
    addChecklistItem: function (id, fields) {
      return teamRef_().collection('checklistItems').add({
        checklistName: fields.checklistName,
        title: fields.title,
        status: fields.status || 'Not started',
        owner: fields.owner || '',
        notes: fields.notes || '',
        photos: fields.photos || [],
        createdAt: new Date().toISOString(),
      });
    },

    updateChecklistItem: function (id, fields) {
      var patch = {};
      if ('title' in fields) patch.title = fields.title;
      if ('status' in fields) patch.status = fields.status;
      if ('owner' in fields) patch.owner = fields.owner;
      if ('notes' in fields) patch.notes = fields.notes;
      if ('photos' in fields) patch.photos = fields.photos;
      return teamRef_().collection('checklistItems').doc(id).update(patch);
    },

    deleteChecklistItem: function (id) {
      return teamRef_().collection('checklistItems').doc(id).delete();
    },

    // people is mentor-write-only per Security Rules — feeds the daily
    // digest email (Code.gs matches a goal's owner name against this list).
    addPerson: function (id, fields) {
      return teamRef_().collection('people').add({
        name: fields.name,
        email: fields.email,
      });
    },

    deletePerson: function (id) {
      return teamRef_().collection('people').doc(id).delete();
    },
  };

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
    post('addDeadline', null, fields, function (ok) {
      if (ok) form.reset();
    });
  }

  function onAddGoal(e) {
    e.preventDefault();
    var form = e.target;
    var ownerGroup = resolveOwnerGroup();
    var fields = {
      title: form.title.value.trim(),
      owner: ownerGroup.owner,
      group: ownerGroup.group,
      targetDate: form.targetDate.value,
    };
    if (!fields.title || !fields.owner) return toast('Goal and your name are required');
    post('addPersonalGoal', null, fields, function (ok) {
      if (ok) {
        form.reset();
        if (el.addGoalOwnerOther) el.addGoalOwnerOther.style.display = 'none';
        if (el.addGoalGroupOther) el.addGoalGroupOther.style.display = 'none';
      }
    });
  }

  function onAddTeamGoal(e) {
    e.preventDefault();
    var form = e.target;
    var ownerGroup = resolveTeamOwnerGroup();
    var fields = {
      title: form.title.value.trim(),
      owner: ownerGroup.owner,
      group: ownerGroup.group,
      targetDate: form.targetDate.value,
    };
    if (!fields.title || !fields.owner) return toast('Goal and at least one name are required');
    post('addTeamGoal', null, fields, function (ok) {
      if (ok) {
        form.reset();
        if (el.addTeamGoalOwnerPicker) {
          Array.prototype.slice.call(el.addTeamGoalOwnerPicker.querySelectorAll('input[type=checkbox]')).forEach(function (cb) {
            cb.checked = false;
            cb.closest('label').classList.remove('checked');
          });
        }
        if (el.addTeamGoalGroupOther) el.addTeamGoalGroupOther.style.display = 'none';
      }
    });
  }

  function onAddNote(e) {
    e.preventDefault();
    var form = e.target;
    var fields = { mentor: form.mentor.value.trim(), note: form.note.value.trim() };
    if (!fields.mentor || !fields.note) return toast('Your name and a note are required');
    post('addMentorNote', null, fields, function (ok) {
      if (ok) form.note.value = '';
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
  // duplicating auth/Firestore/toast logic. Their calls (state.data,
  // post(), onData()) are unchanged from the old Sheets-backed version —
  // only what's behind this surface changed.
  window.DB = {
    view: VIEW,
    state: state,
    teamConfig: teamConfig,
    withPasscode: withPasscode,
    load: function () {}, // no-op: onSnapshot keeps state.data current on its own now
    post: post,
    toast: toast,
    escapeHtml: escapeHtml,
    urgencyClass: urgencyClass,
    buildCard: buildCard, // the editable card (Edit + Add-to-calendar) used everywhere else — reuse it, don't rebuild it
    uploadPhoto: uploadPhoto,
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
