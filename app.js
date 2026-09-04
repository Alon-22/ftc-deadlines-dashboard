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
    if (el.addGoalForm) wireDifficultyEstimate(el.addGoalForm, el.addGoalPointsStatus);
    if (el.addTeamGoalForm) wireDifficultyEstimate(el.addTeamGoalForm, el.addTeamGoalPointsStatus);
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
    el.addGoalPointsStatus = document.getElementById('add-goal-points-status');
    el.addTeamGoalPointsStatus = document.getElementById('add-team-goal-points-status');
    el.addNoteForm = document.getElementById('add-note-form');
    el.gate = document.getElementById('gate');
    el.gateInput = document.getElementById('gate-passcode');
    el.gateSubmit = document.getElementById('gate-submit');
    el.toast = document.getElementById('toast');
    el.tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
    el.tabPanels = Array.prototype.slice.call(document.querySelectorAll('.tab-panel'));
    el.tabGroupButtons = Array.prototype.slice.call(document.querySelectorAll('.tab-group-btn'));
    el.tabGroups = Array.prototype.slice.call(document.querySelectorAll('.tab-bar .tab-group'));
  }

  function initTabs() {
    if (!el.tabButtons.length) return; // page has no tab bar, skip
    el.tabButtons.forEach(function (btn) {
      btn.addEventListener('click', function () { showTab(btn.dataset.tab); });
    });
    el.tabGroupButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        showGroup_(btn.dataset.group);
        var firstTab = firstTabInGroup_(btn.dataset.group);
        if (firstTab) showTab(firstTab);
      });
    });
    var last = localStorage.getItem('lastTab:' + VIEW);
    showTab(el.tabButtons.some(function (b) { return b.dataset.tab === last; }) ? last : el.tabButtons[0].dataset.tab);
  }

  // The flat tab bar grew to 15+ items over many sessions, which meant
  // endless silent horizontal scrolling with no indication anything was
  // off-screen — these two group the tabs into a handful of categories
  // (a pill row picks the category, only that category's tabs show) so no
  // single row ever has more than a few items in it.
  function groupForTab_(name) {
    var btn = el.tabButtons.filter(function (b) { return b.dataset.tab === name; })[0];
    var group = btn && btn.closest('.tab-group');
    return group && group.dataset.group;
  }

  function firstTabInGroup_(group) {
    var groupEl = el.tabGroups.filter(function (g) { return g.dataset.group === group; })[0];
    var btn = groupEl && groupEl.querySelector('.tab-btn');
    return btn && btn.dataset.tab;
  }

  function showGroup_(group) {
    el.tabGroupButtons.forEach(function (btn) { btn.classList.toggle('active', btn.dataset.group === group); });
    el.tabGroups.forEach(function (g) { g.classList.toggle('active', g.dataset.group === group); });
  }

  function showTab(name) {
    el.tabButtons.forEach(function (btn) { btn.classList.toggle('active', btn.dataset.tab === name); });
    el.tabPanels.forEach(function (panel) { panel.classList.toggle('active', panel.dataset.tab === name); });
    showGroup_(groupForTab_(name));
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

  // Best-effort title + price lookup for the Budget tab's "paste a link"
  // auto-fill — Code.gs fetches the vendor page server-side (a browser
  // can't; the vendor's CORS policy blocks a cross-origin fetch from here)
  // and scrapes for both. May come back empty for sites it can't parse —
  // callers should treat that as "couldn't find one," not an error to
  // surface loudly. cb(null, errorMessage) on failure, cb({price, title}, null) on success.
  function lookupPartPrice(url, cb) {
    var team = teamConfig();
    if (!team) return cb(null, 'No team selected');
    fetch(team.webAppUrl, {
      method: 'POST',
      body: JSON.stringify({
        action: 'lookupPartPrice',
        team: state.team,
        view: VIEW,
        passcode: state.passcode,
        fields: { url: url },
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.ok) return cb(null, json.error);
        cb({ price: json.price, title: json.title || '', inStock: json.inStock }, null);
      })
      .catch(function (err) { cb(null, String(err)); });
  }

  // Emails a Request-for-Purchase cart to a set of already-resolved
  // addresses — recipient resolution happens client-side (budget.js
  // matches the People directory against this team's mentor roster);
  // Code.gs only ever does the one thing only it can, which is send mail.
  function sendPurchaseRequestEmail(to, subject, body, cb) {
    var team = teamConfig();
    if (!team) return cb(false, 'No team selected');
    fetch(team.webAppUrl, {
      method: 'POST',
      body: JSON.stringify({
        action: 'sendPurchaseRequestEmail',
        team: state.team,
        view: VIEW,
        passcode: state.passcode,
        fields: { to: to, subject: subject, body: body },
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (json) { cb(json.ok, json.error); })
      .catch(function (err) { cb(false, String(err)); });
  }

  // Suggests a 1-5 point/difficulty value for a new goal via Gemini — a
  // starting point only, never written anywhere on its own; the add-goal
  // forms pre-fill their (always-editable) Points field with this and the
  // team can freely override it before or after saving.
  function estimateDifficulty(title, notes, cb) {
    var team = teamConfig();
    if (!team) return cb(null, 'No team selected');
    fetch(team.webAppUrl, {
      method: 'POST',
      body: JSON.stringify({
        action: 'estimateDifficulty',
        team: state.team,
        view: VIEW,
        passcode: state.passcode,
        fields: { title: title, notes: notes || '' },
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json.ok) return cb(null, json.error);
        cb({ points: json.points, reasoning: json.reasoning || '' }, null);
      })
      .catch(function (err) { cb(null, String(err)); });
  }

  // On leaving the title field of an add-goal form, suggest a points value
  // via estimateDifficulty — never overwrites a value someone already typed
  // (same "don't clobber what's there" convention as Budget's link autofill).
  function wireDifficultyEstimate(form, statusEl) {
    if (!form.title || !form.points) return;
    form.title.addEventListener('change', function () {
      var title = form.title.value.trim();
      if (statusEl) statusEl.textContent = '';
      if (!title || form.points.value) return;
      if (statusEl) statusEl.textContent = '🤔 Estimating difficulty…';
      estimateDifficulty(title, '', function (info, err) {
        if (statusEl) statusEl.textContent = '';
        if (!info) { if (statusEl && err) statusEl.textContent = ''; return; }
        if (!form.points.value) {
          form.points.value = info.points;
          if (statusEl) statusEl.textContent = '🤖 Suggested ' + info.points + ' pts' + (info.reasoning ? ' — ' + info.reasoning : '') + ' (edit freely)';
        }
      });
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
      ensureData_().mentors = teamMentors;
      recomputeAndRender();
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

    unsubscribers.push(teamRef.collection('activity').onSnapshot(function (snap) {
      ensureData_().activity = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
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

    unsubscribers.push(teamRef.collection('parts').onSnapshot(function (snap) {
      ensureData_().parts = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
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
    if (!state.data) state.data = { items: [], seasonLog: [], views: [], subtasks: [], mentorNotes: [], comments: [], notebook: [], checklistItems: [], people: [], parts: [], mentors: [], activity: [] };
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
      points: g.points == null ? null : g.points,
      splitFrom: g.splitFrom || '',
      splitInto: g.splitInto || [],
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
      owner: d.owner || '',
      group: '',
      startDate: d.startDate || null,
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
    title.className = 'card-title card-title-clickable';
    title.textContent = item.title;
    title.title = 'Click to edit';
    title.addEventListener('click', function () { openEditModal(item); });
    titleWrap.appendChild(title);

    var meta = document.createElement('div');
    meta.className = 'card-meta';
    var metaBits = [];
    if (item.owner) metaBits.push(item.owner);
    if (item.group) metaBits.push(item.group);
    if (item.isMentorOwned) metaBits.push('mentor goal');
    meta.textContent = metaBits.join(' · ');
    titleWrap.appendChild(meta);

    var badgeRow = document.createElement('div');
    badgeRow.className = 'card-badge-row';

    if (item.status) {
      var badge = document.createElement('span');
      badge.className = 'badge status-' + item.status.toLowerCase().replace(/\s+/g, '-');
      badge.textContent = item.status;
      badgeRow.appendChild(badge);
    }

    if (item.points) {
      var pointsBadge = document.createElement('span');
      pointsBadge.className = 'badge points-badge';
      pointsBadge.textContent = item.points + (item.points === 1 ? ' pt' : ' pts');
      badgeRow.appendChild(pointsBadge);
    }

    var blocker = blockingGoal_(item);
    if (blocker) {
      var blockedBadge = document.createElement('span');
      blockedBadge.className = 'badge blocked-badge';
      blockedBadge.textContent = '🔒 Blocked by: ' + blocker.title;
      badgeRow.appendChild(blockedBadge);
    }

    if (item.splitFrom) {
      var parent = (state.data.items || []).filter(function (i) { return i.id === item.splitFrom; })[0];
      var splitFromBadge = document.createElement('span');
      splitFromBadge.className = 'badge split-badge';
      splitFromBadge.textContent = '↗ Split from: ' + (parent ? parent.title : 'a goal');
      badgeRow.appendChild(splitFromBadge);
    }

    if (item.splitInto && item.splitInto.length) {
      var splitIntoBadge = document.createElement('span');
      splitIntoBadge.className = 'badge split-badge';
      splitIntoBadge.textContent = '↘ Split into ' + item.splitInto.length + (item.splitInto.length === 1 ? ' goal' : ' goals');
      badgeRow.appendChild(splitIntoBadge);
    }

    var commentCount = item.type === 'goal' ? commentsFor(item.id).length : 0;
    if (commentCount) {
      var commentBadge = document.createElement('span');
      commentBadge.className = 'badge comment-badge';
      commentBadge.textContent = '💬 ' + commentCount;
      badgeRow.appendChild(commentBadge);
    }

    if (badgeRow.children.length) titleWrap.appendChild(badgeRow);

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
    var historyBtn = document.createElement('button');
    historyBtn.className = 'secondary';
    historyBtn.textContent = '🕓 History';
    historyBtn.title = 'Edit, comment, add sub-tasks, or see everything that\'s happened to this ' + item.type;
    historyBtn.addEventListener('click', function () { openEditModal(item); });
    actions.appendChild(historyBtn);

    if (item.targetDate) {
      var calBtn = document.createElement('a');
      calBtn.className = 'secondary icon-btn';
      calBtn.textContent = '📅';
      calBtn.title = 'Add to my calendar';
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

  // ===== Edit modal ============================================================
  // The one editor for a task, reachable by clicking it anywhere it appears —
  // card, Kanban card, Gantt bar or priority row, Calendar pill, To-Do title.
  // Every one of those files is a different shape of DOM, so a shared inline
  // expand (like the old per-card panel this replaced) can't work uniformly;
  // a modal can. Exposed as DB.editItem so those other files can call it too.

  function dateInputValue_(iso) {
    return iso ? new Date(iso).toISOString().slice(0, 10) : '';
  }

  function closeModal_() {
    var existing = document.querySelector('.modal-overlay');
    if (existing) existing.remove();
  }

  function openEditModal(item) {
    closeModal_(); // only one at a time

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal_(); });

    var dialog = document.createElement('div');
    dialog.className = 'modal-dialog';
    overlay.appendChild(dialog);

    var heading = document.createElement('h3');
    heading.textContent = item.type === 'deadline' ? 'Edit deadline' : 'Edit goal';
    dialog.appendChild(heading);

    var titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = item.title || '';
    titleInput.placeholder = 'Title';
    dialog.appendChild(titleInput);

    var ownerRow = document.createElement('div');
    ownerRow.className = 'row';
    var ownerInput = document.createElement('input');
    ownerInput.type = 'text';
    ownerInput.value = item.owner || '';
    ownerInput.placeholder = 'Name(s), comma-separated';
    ownerRow.appendChild(ownerInput);

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
      ownerRow.appendChild(statusSelect);
    }

    var pointsInput;
    if (item.type === 'goal') {
      pointsInput = document.createElement('input');
      pointsInput.type = 'number';
      pointsInput.min = '1';
      pointsInput.max = '5';
      pointsInput.placeholder = 'Points';
      pointsInput.title = 'Difficulty / effort points (1-5)';
      pointsInput.value = item.points || '';
      ownerRow.appendChild(pointsInput);
    }
    dialog.appendChild(ownerRow);

    var dateRow = document.createElement('div');
    dateRow.className = 'row';
    var startInput = document.createElement('input');
    startInput.type = 'date';
    startInput.value = dateInputValue_(item.startDate);
    startInput.title = 'Start date';
    dateRow.appendChild(startInput);
    var targetInput = document.createElement('input');
    targetInput.type = 'date';
    targetInput.value = dateInputValue_(item.targetDate);
    targetInput.title = item.type === 'deadline' ? 'Event date' : 'Target date';
    dateRow.appendChild(targetInput);
    dialog.appendChild(dateRow);

    var linkInput;
    if (item.type === 'goal') {
      linkInput = document.createElement('input');
      linkInput.type = 'text';
      linkInput.value = item.link || '';
      linkInput.placeholder = 'Link to CAD/design file/doc (optional)';
      dialog.appendChild(linkInput);
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
          var shortTitle = g.title.length > 40 ? g.title.slice(0, 40) + '…' : g.title;
          opt.textContent = 'Blocked by: ' + shortTitle;
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

      dialog.appendChild(depRow);
    }

    var textarea = document.createElement('textarea');
    textarea.value = item.notes || '';
    textarea.placeholder = 'What moved since last time?';
    dialog.appendChild(textarea);

    var row = document.createElement('div');
    row.className = 'modal-actions';
    var saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeModal_);
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);

    // Deleting a goal or deadline outright (not just marking it Done) is
    // mentor-only — students can edit their own items but shouldn't be able
    // to unilaterally erase team goals or competition deadlines.
    if (VIEW === 'mentor') {
      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'secondary';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', function () {
        if (!window.confirm('Delete "' + item.title + '"? This can\'t be undone.')) return;
        var action = item.type === 'deadline' ? 'deleteDeadline' : 'deleteGoal';
        post(action, item.id, {}, function (ok) {
          if (ok) closeModal_();
        });
      });
      row.appendChild(deleteBtn);
    }

    if (item.type === 'goal') {
      var splitBtn = document.createElement('button');
      splitBtn.type = 'button';
      splitBtn.className = 'secondary';
      splitBtn.textContent = 'Split into goals…';
      splitBtn.addEventListener('click', function () {
        var existingForm = dialog.querySelector('.split-form');
        if (existingForm) { existingForm.remove(); return; }
        // Insert right after the Save/Cancel/Delete row — not at the end of
        // the dialog — so it appears next to the button that opened it
        // instead of below the whole History section.
        dialog.insertBefore(buildSplitForm_(item), row.nextSibling);
      });
      row.appendChild(splitBtn);
    }

    dialog.appendChild(row);

    if (item.type === 'goal') dialog.appendChild(buildHistorySection_(item));

    saveBtn.addEventListener('click', function () {
      var fields = {
        title: titleInput.value.trim(),
        owner: ownerInput.value.trim(),
        startDate: startInput.value,
        targetDate: targetInput.value,
      };
      if (item.type === 'deadline') {
        fields.notes = textarea.value;
      } else {
        fields.lastUpdate = textarea.value;
        fields.status = statusSelect.value;
        fields.link = linkInput.value.trim();
        fields.blockedBy = blockedBySelect.value;
        fields.repeats = repeatsSelect.value;
        fields.points = pointsInput.value;
      }
      var action = item.type === 'deadline' ? 'updateDeadline' : 'updateGoal';
      post(action, item.id, fields, function (ok) {
        if (ok) closeModal_();
      });
    });

    document.body.appendChild(overlay);
    titleInput.focus();
  }

  // ===== Splitting a goal ======================================================
  // Keeps the "we used to have one goal" trail on both ends: the original
  // is marked Done with a splitInto list, each new goal gets a splitFrom
  // pointer, and a reason is required so it always reads as a deliberate
  // decision, not just a goal quietly vanishing and reappearing as two.

  function buildSplitForm_(item) {
    var wrap = document.createElement('div');
    wrap.className = 'split-form';

    var heading = document.createElement('h4');
    heading.textContent = 'Split "' + item.title + '" into new goals';
    wrap.appendChild(heading);

    var reasonInput = document.createElement('textarea');
    reasonInput.placeholder = 'Why are we splitting this goal? (required)';
    wrap.appendChild(reasonInput);

    var rowsWrap = document.createElement('div');
    wrap.appendChild(rowsWrap);

    function addGoalRow() {
      var r = document.createElement('div');
      r.className = 'row split-goal-row';
      var t = document.createElement('input');
      t.type = 'text';
      t.placeholder = 'New goal title';
      var o = document.createElement('input');
      o.type = 'text';
      o.placeholder = 'Owner(s)';
      o.value = item.owner || '';
      r.appendChild(t);
      r.appendChild(o);
      rowsWrap.appendChild(r);
    }
    addGoalRow();
    addGoalRow();

    var addRowBtn = document.createElement('button');
    addRowBtn.type = 'button';
    addRowBtn.className = 'secondary';
    addRowBtn.textContent = '+ Add another goal';
    addRowBtn.addEventListener('click', addGoalRow);
    wrap.appendChild(addRowBtn);

    var actionsRow = document.createElement('div');
    actionsRow.className = 'modal-actions';
    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'Split';
    confirmBtn.addEventListener('click', function () {
      var reason = reasonInput.value.trim();
      if (!reason) return toast('A reason for the split is required');
      var goals = Array.prototype.slice.call(rowsWrap.querySelectorAll('.split-goal-row')).map(function (r) {
        var inputs = r.querySelectorAll('input');
        return { title: inputs[0].value.trim(), owner: inputs[1].value.trim() };
      }).filter(function (g) { return g.title; });
      if (goals.length < 2) return toast('Enter at least two new goal titles');
      post('splitGoal', item.id, { reason: reason, goals: goals }, function (ok) {
        if (ok) closeModal_();
      });
    });
    var cancelSplitBtn = document.createElement('button');
    cancelSplitBtn.type = 'button';
    cancelSplitBtn.className = 'secondary';
    cancelSplitBtn.textContent = 'Cancel';
    cancelSplitBtn.addEventListener('click', function () { wrap.remove(); });
    actionsRow.appendChild(confirmBtn);
    actionsRow.appendChild(cancelSplitBtn);
    wrap.appendChild(actionsRow);

    return wrap;
  }

  // ===== Goal modal History section (sub-tasks + comments + activity feed) ===

  function startOfWeekIso_(date) {
    var d = new Date(date);
    d.setHours(0, 0, 0, 0);
    var day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
    return d.toISOString().slice(0, 10);
  }

  function buildSubtaskRow_(s) {
    var row = document.createElement('label');
    row.className = 'todo-subtask-row' + (s.done ? ' done' : '');

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.done;
    cb.addEventListener('change', function () {
      post('toggleSubtask', s.id, { done: cb.checked }, function () {});
    });
    row.appendChild(cb);

    var span = document.createElement('span');
    span.textContent = s.text;
    row.appendChild(span);

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'subtask-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete sub-task';
    delBtn.addEventListener('click', function (e) {
      e.preventDefault();
      post('deleteSubtask', s.id, {}, function () {});
    });
    row.appendChild(delBtn);

    return row;
  }

  function buildSubtaskSection_(item) {
    var wrap = document.createElement('div');

    var list = document.createElement('div');
    (state.data.subtasks || []).filter(function (s) { return s.goalId === item.id; })
      .sort(function (a, b) { return (a.createdAt || '').localeCompare(b.createdAt || ''); })
      .forEach(function (s) { list.appendChild(buildSubtaskRow_(s)); });
    wrap.appendChild(list);

    var addRow = document.createElement('div');
    addRow.className = 'todo-add-subtask';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Add a sub-task…';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary';
    btn.textContent = 'Add';
    function submit() {
      var text = input.value.trim();
      if (!text) return;
      post('addSubtask', null, { goalId: item.id, owner: item.owner, weekOf: startOfWeekIso_(new Date()), text: text }, function (ok) {
        if (ok) input.value = '';
      });
    }
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    addRow.appendChild(input);
    addRow.appendChild(btn);
    wrap.appendChild(addRow);

    return wrap;
  }

  // Merges edit-activity entries, comments, and sub-task create/complete
  // events into one chronological read-only feed — "what's happened to
  // this goal" without hunting across three different UI sections.
  function buildHistoryFeed_(item) {
    var entries = [];
    (state.data.activity || []).filter(function (a) { return a.goalId === item.id; }).forEach(function (a) {
      entries.push({ at: a.createdAt, text: a.summary });
    });
    commentsFor(item.id).forEach(function (c) {
      entries.push({ at: c.createdAt, text: '💬 ' + (c.author || 'Unknown') + ': ' + c.text });
    });
    (state.data.subtasks || []).filter(function (s) { return s.goalId === item.id; }).forEach(function (s) {
      if (s.createdAt) entries.push({ at: s.createdAt, text: 'Sub-task added: ' + s.text });
      if (s.done && s.completedAt) entries.push({ at: s.completedAt, text: 'Sub-task completed: ' + s.text });
    });
    entries.sort(function (a, b) { return (b.at || '').localeCompare(a.at || ''); });
    return entries;
  }

  function buildHistorySection_(item) {
    var wrap = document.createElement('div');
    wrap.className = 'history-section';

    var subtasksHeading = document.createElement('h4');
    subtasksHeading.textContent = 'Sub-tasks';
    wrap.appendChild(subtasksHeading);
    wrap.appendChild(buildSubtaskSection_(item));

    var commentsHeading = document.createElement('h4');
    commentsHeading.textContent = 'Comments';
    wrap.appendChild(commentsHeading);
    var commentList = document.createElement('div');
    renderCommentList(commentList, commentsFor(item.id));
    wrap.appendChild(commentList);
    wrap.appendChild(buildAddCommentForm_(item));

    var historyHeading = document.createElement('h4');
    historyHeading.textContent = 'Activity';
    wrap.appendChild(historyHeading);
    var feed = buildHistoryFeed_(item);
    var feedList = document.createElement('div');
    if (!feed.length) {
      feedList.innerHTML = '<p class="empty-state">No activity yet.</p>';
    } else {
      feed.forEach(function (entry) {
        var e = document.createElement('div');
        e.className = 'note-entry';
        var meta = document.createElement('div');
        meta.className = 'note-meta';
        meta.textContent = entry.at ? new Date(entry.at).toLocaleString() : '';
        var text = document.createElement('div');
        text.textContent = entry.text;
        e.appendChild(meta);
        e.appendChild(text);
        feedList.appendChild(e);
      });
    }
    wrap.appendChild(feedList);

    return wrap;
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

  // Small add-comment form reused inside the goal modal's History section.
  function buildAddCommentForm_(item) {
    var form = document.createElement('div');
    form.className = 'card-actions comments-add';
    var authorInput = document.createElement('input');
    authorInput.type = 'text';
    authorInput.placeholder = 'Your name';
    var textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.placeholder = 'Add a comment…';
    var sendBtn = document.createElement('button');
    sendBtn.type = 'button';
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
    return form;
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

  // ===== Per-goal activity feed ================================================
  // A lightweight, best-effort log — never blocks or fails the actual write
  // it's describing. Shown alongside comments/subtasks in the goal modal's
  // History section so "what happened to this goal" doesn't require asking
  // around.

  function logActivity_(goalId, summary) {
    return teamRef_().collection('activity').add({
      goalId: goalId,
      summary: summary,
      role: VIEW,
      createdAt: new Date().toISOString(),
    }).catch(function () { /* best-effort — never surface an activity-log failure as a save error */ });
  }

  var GOAL_FIELD_LABELS_ = { title: 'Title', owner: 'Owner', status: 'Status', notes: 'Notes', link: 'Link', blockedBy: 'Blocked by', repeats: 'Repeats', points: 'Points', startDate: 'Start date', targetDate: 'Target date' };

  function describeGoalChanges_(existing, patch) {
    var bits = [];
    Object.keys(patch).forEach(function (key) {
      if (key === 'owners') return; // derived from owner — don't double-report
      var before = existing[key];
      var after = patch[key];
      if (before === after) return;
      var label = GOAL_FIELD_LABELS_[key] || key;
      if (key === 'startDate' || key === 'targetDate') {
        bits.push(label + ': ' + (after ? new Date(after).toLocaleDateString() : '(cleared)'));
      } else if (key === 'blockedBy') {
        bits.push(after ? 'Marked as blocked' : 'Blocker cleared');
      } else if (key === 'status') {
        bits.push('Status: ' + (before || '(none)') + ' → ' + after);
      } else if (key === 'notes') {
        bits.push('Notes updated');
      } else {
        bits.push(label + ': ' + after);
      }
    });
    return bits.join('; ');
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
      if ('title' in fields) patch.title = fields.title;
      if ('owner' in fields) { patch.owner = fields.owner; patch.owners = ownerNames_(fields.owner); }
      if ('status' in fields) patch.status = fields.status;
      if ('lastUpdate' in fields) patch.notes = fields.lastUpdate;
      if ('link' in fields) patch.link = fields.link;
      if ('blockedBy' in fields) patch.blockedBy = fields.blockedBy;
      if ('repeats' in fields) patch.repeats = fields.repeats;
      if ('points' in fields) patch.points = fields.points === '' || fields.points == null ? null : Number(fields.points);
      if ('startDate' in fields) patch.startDate = fields.startDate ? new Date(fields.startDate).toISOString() : null;
      if ('targetDate' in fields) patch.targetDate = fields.targetDate ? new Date(fields.targetDate).toISOString() : null;

      var existing = (state.data.items || []).filter(function (i) { return i.id === id && i.type === 'goal'; })[0];
      var justCompletedRecurring = existing && existing.status !== 'Done' && patch.status === 'Done' &&
        existing.repeats && existing.repeats !== 'none';
      var changeSummary = existing && describeGoalChanges_(existing, patch);

      return teamRef_().collection('goals').doc(id).update(patch).then(function () {
        if (changeSummary) logActivity_(id, changeSummary);
        if (justCompletedRecurring) return spawnNextRecurrence_(existing);
      });
    },

    updateDeadline: function (id, fields) {
      var patch = {};
      if ('title' in fields) patch.title = fields.title;
      if ('owner' in fields) patch.owner = fields.owner;
      if ('notes' in fields) patch.notes = fields.notes;
      if ('startDate' in fields) patch.startDate = fields.startDate ? new Date(fields.startDate).toISOString() : null;
      if ('targetDate' in fields) patch.targetDate = fields.targetDate ? new Date(fields.targetDate).toISOString() : null;
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

    deleteGoal: function (id) {
      return teamRef_().collection('goals').doc(id).delete();
    },

    deleteDeadline: function (id) {
      return teamRef_().collection('deadlines').doc(id).delete();
    },

    // Splits one goal into several new ones, keeping the paper trail both
    // directions: the original is marked Done (its work now lives as the
    // new goals) and gets a splitInto list; each new goal gets a splitFrom
    // pointer back. fields.goals is [{title, owner}, ...]; fields.reason is
    // required (checked client-side before this is ever called) so a split
    // always comes with a "why", not just a silent fork.
    splitGoal: function (id, fields) {
      var existing = (state.data.items || []).filter(function (i) { return i.id === id && i.type === 'goal'; })[0];
      if (!existing) return Promise.reject(new Error('Goal not found'));
      var goalsColl = teamRef_().collection('goals');
      var newRefs = fields.goals.map(function () { return goalsColl.doc(); });
      var batch = db.batch();
      fields.goals.forEach(function (g, i) {
        var owners = ownerNames_(g.owner);
        batch.set(newRefs[i], {
          title: g.title,
          owner: g.owner || '',
          owners: owners,
          group: existing.group || '',
          subtype: existing.subtype,
          status: 'Not started',
          notes: '',
          startDate: new Date().toISOString(),
          targetDate: existing.targetDate || null,
          priorityOrder: null,
          points: null,
          splitFrom: id,
          isMentorOwned: owners.some(function (n) { return teamMentors.indexOf(n) !== -1; }),
        });
      });
      var newIds = newRefs.map(function (r) { return r.id; });
      batch.update(goalsColl.doc(id), {
        status: 'Done',
        splitInto: newIds,
        notes: (existing.notes ? existing.notes + '\n\n' : '') + 'Split into ' + newIds.length + ' goals — ' + fields.reason,
      });
      return batch.commit().then(function () {
        var titles = fields.goals.map(function (g) { return g.title; }).join(', ');
        logActivity_(id, 'Split into: ' + titles + ' — ' + fields.reason);
        newIds.forEach(function (newId) { logActivity_(newId, 'Split from: ' + existing.title + ' — ' + fields.reason); });
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
        points: fields.points ? Number(fields.points) : null,
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
        points: fields.points ? Number(fields.points) : null,
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

    // Competition-day/awards-prep checklists get reused across every
    // event, unlike the one-and-done Portfolio — this is how they go back
    // to blank between competitions instead of needing to be rebuilt.
    resetChecklistItems: function (id, fields) {
      var ids = (state.data.checklistItems || [])
        .filter(function (i) { return i.checklistName === fields.checklistName; })
        .map(function (i) { return i.id; });
      var batch = db.batch();
      ids.forEach(function (itemId) {
        batch.update(teamRef_().collection('checklistItems').doc(itemId), { status: 'Not started' });
      });
      return batch.commit();
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

    addPart: function (id, fields) {
      return teamRef_().collection('parts').add({
        item: fields.item,
        vendor: fields.vendor || '',
        link: fields.link || '',
        cost: Number(fields.cost) || 0,
        qty: Number(fields.qty) || 1,
        status: fields.status || 'Wishlist',
        createdAt: new Date().toISOString(),
      });
    },

    updatePart: function (id, fields) {
      var patch = {};
      if ('item' in fields) patch.item = fields.item;
      if ('vendor' in fields) patch.vendor = fields.vendor;
      if ('link' in fields) patch.link = fields.link;
      if ('cost' in fields) patch.cost = Number(fields.cost) || 0;
      if ('qty' in fields) patch.qty = Number(fields.qty) || 1;
      if ('status' in fields) patch.status = fields.status;
      return teamRef_().collection('parts').doc(id).update(patch);
    },

    deletePart: function (id) {
      return teamRef_().collection('parts').doc(id).delete();
    },

    // Bulk "mark this vendor's cart as ordered" after exporting a Request
    // for Purchase — same batch-write pattern resetChecklistItems uses.
    markPartsOrdered: function (id, fields) {
      var batch = db.batch();
      (fields.ids || []).forEach(function (partId) {
        batch.update(teamRef_().collection('parts').doc(partId), { status: 'Ordered' });
      });
      return batch.commit();
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
      points: form.points ? form.points.value : '',
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
      points: form.points ? form.points.value : '',
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
    editItem: openEditModal, // the shared edit modal — kanban/gantt/calendar/todo call this on click since they don't render full cards
    uploadPhoto: uploadPhoto,
    lookupPartPrice: lookupPartPrice,
    sendPurchaseRequestEmail: sendPurchaseRequestEmail,
    estimateDifficulty: estimateDifficulty,
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
