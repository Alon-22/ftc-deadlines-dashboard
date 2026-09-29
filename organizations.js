// organizations.js — mentor-only Organizations tab: shows every org and its
// teams (the same public directory app.js's team-select dropdown reads),
// lets a mentor add a sibling team to the org they're already signed into
// (using the mentor passcode they already entered at the gate — see
// Code.gs's createTeam_, which verifies that passcode's team really belongs
// to this org), and lets a site admin create a brand-new organization.
// Every creation displays its freshly generated passcodes once, since
// there's no other way to see them again short of getTeamPasscodes.
//
// Each team in the tree also expands into its member roster (reusing the
// People collection app.js's People tab already reads/writes — see
// loadTeamMembers/addTeamMember/removeTeamMember) so a mentor can add
// students to any team in their own org right from this tree, without
// switching teams first. Only expandable for teams in the signed-in
// mentor's own org — firestore.rules' mentorInSameOrg is what actually
// enforces that boundary; this is just matching UI to what will succeed.
//
// Each org (not each team) also has one Subteams panel — the shared list of
// subteam/skill-area names every team in the org draws its goal-form
// dropdown from (see app.js's populateAddGoalOptions and the
// addSubteam/deleteSubteam handlers).

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    tree: document.getElementById('organizations-tree'),
    newTeamForm: document.getElementById('add-team-form'),
    newTeamResult: document.getElementById('add-team-result'),
    newOrgForm: document.getElementById('add-org-form'),
    newOrgResult: document.getElementById('add-org-result'),
    lookupForm: document.getElementById('lookup-passcodes-form'),
    lookupResult: document.getElementById('lookup-passcodes-result'),
  };
  if (!el.tree) return; // no Organizations tab on this page

  var expandedTeam = null; // team key whose roster panel is open, one at a time
  var subteamsExpanded = false; // whether the (single) org-level Subteams panel is open

  // app.js's own DOMContentLoaded listener (registered first, since app.js
  // loads before this file) is what actually creates the Firestore handle
  // this tab reads — wait for that same event rather than reading it here
  // at script-parse time, before it exists.
  document.addEventListener('DOMContentLoaded', loadTree);

  // The DOMContentLoaded render above happens before a mentor still at the
  // passcode gate has actually signed in, so DB.state.org is still null and
  // every org looks like someone else's — every team's roster then renders
  // as non-manageable. onData's first callback only ever fires after a real
  // sign-in (it's what subscribeToTeam feeds), so reload once then to pick
  // up the now-correct org — not on every later tick, or an expanded roster
  // panel would get discarded under the mentor's hands each time any team
  // data changes.
  var reloadedAfterSignIn = false;
  DB.onData(function () {
    if (reloadedAfterSignIn) return;
    reloadedAfterSignIn = true;
    loadTree();
  });

  function loadTree() {
    el.tree.innerHTML = '<p class="empty-state">Loading organizations…</p>';
    DB.loadOrgTree(function (orgs, err) {
      if (err) {
        el.tree.innerHTML = '<p class="empty-state">Could not load organizations: ' + DB.escapeHtml(err) + '</p>';
        return;
      }
      renderTree(orgs);
    });
  }

  function renderTree(orgs) {
    el.tree.innerHTML = '';
    if (!orgs.length) {
      el.tree.innerHTML = '<p class="empty-state">No organizations yet.</p>';
      return;
    }
    orgs.forEach(function (org) {
      var section = document.createElement('div');
      section.className = 'org-tree-entry';

      var heading = document.createElement('h3');
      heading.textContent = org.name + (org.id === DB.state.org ? ' (your org)' : '');
      section.appendChild(heading);

      // Subteam names are org-scoped (one shared list, not per-team) so
      // this only ever appears once per org, not once per team row — and
      // only for the mentor's own org, same reasoning as team rosters.
      if (org.id === DB.state.org) {
        var subteamsToggle = document.createElement('button');
        subteamsToggle.type = 'button';
        subteamsToggle.className = 'secondary';
        subteamsToggle.textContent = subteamsExpanded ? 'Hide subteams' : 'Subteams';
        subteamsToggle.addEventListener('click', function () {
          subteamsExpanded = !subteamsExpanded;
          loadTree();
        });
        section.appendChild(subteamsToggle);
        if (subteamsExpanded) section.appendChild(buildSubteamsPanel_());
      }

      if (!org.teams.length) {
        var empty = document.createElement('p');
        empty.className = 'card-meta';
        empty.textContent = 'No teams yet.';
        section.appendChild(empty);
      } else {
        var list = document.createElement('ul');
        list.className = 'org-tree-teams';
        org.teams.forEach(function (team) {
          list.appendChild(buildTeamRow(team, org.id === DB.state.org));
        });
        section.appendChild(list);
      }

      el.tree.appendChild(section);
    });
  }

  function buildTeamRow(team, isOwnOrg) {
    var item = document.createElement('li');

    var row = document.createElement('div');
    row.className = 'org-tree-team-row';
    var label = document.createElement('span');
    label.textContent = team.label + (team.key === DB.state.team ? ' (current)' : '');
    row.appendChild(label);

    if (isOwnOrg) {
      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'secondary';
      toggleBtn.textContent = expandedTeam === team.key ? 'Hide students' : 'Students';
      toggleBtn.addEventListener('click', function () {
        expandedTeam = expandedTeam === team.key ? null : team.key;
        loadTree();
      });
      row.appendChild(toggleBtn);
    }
    item.appendChild(row);

    if (isOwnOrg && expandedTeam === team.key) {
      item.appendChild(buildMembersPanel(team.key));
    }

    return item;
  }

  function buildMembersPanel(teamKey) {
    var panel = document.createElement('div');
    panel.className = 'org-tree-members-panel';

    var list = document.createElement('div');
    list.className = 'org-tree-members-list';
    panel.appendChild(list);
    loadMembersInto_(teamKey, list);

    var form = document.createElement('form');
    form.className = 'add-form org-tree-add-member-form';
    var row = document.createElement('div');
    row.className = 'row';
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Student name';
    nameInput.required = true;
    row.appendChild(nameInput);
    var emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.placeholder = 'Email (optional)';
    row.appendChild(emailInput);
    form.appendChild(row);
    var addBtn = document.createElement('button');
    addBtn.type = 'submit';
    addBtn.textContent = 'Add student';
    form.appendChild(addBtn);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = nameInput.value.trim();
      if (!name) return;
      DB.addTeamMember(teamKey, name, emailInput.value.trim(), function (ok) {
        if (ok) { form.reset(); loadMembersInto_(teamKey, list); }
      });
    });
    panel.appendChild(form);

    return panel;
  }

  function loadMembersInto_(teamKey, list) {
    list.innerHTML = '<p class="card-meta">Loading students…</p>';
    DB.loadTeamMembers(teamKey, function (members, err) {
      list.innerHTML = '';
      if (err) {
        list.innerHTML = '<p class="empty-state">Could not load students: ' + DB.escapeHtml(err) + '</p>';
        return;
      }
      if (!members.length) {
        list.innerHTML = '<p class="empty-state">No students added yet.</p>';
        return;
      }
      members.forEach(function (m) {
        var row = document.createElement('div');
        row.className = 'org-tree-member-row';
        var text = document.createElement('span');
        text.textContent = m.name + (m.email ? ' — ' + m.email : '');
        row.appendChild(text);
        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'secondary';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', function () {
          DB.removeTeamMember(teamKey, m.id, function () { loadMembersInto_(teamKey, list); });
        });
        row.appendChild(removeBtn);
        list.appendChild(row);
      });
    });
  }

  // Subteam names feed the goal-form "subteam / skill area" dropdowns (see
  // app.js's populateAddGoalOptions) — org-scoped so every team in the org
  // shares one list. DB.state.data.subteams is already live (subscribeToTeam
  // has an onSnapshot on it), so this reads straight from there instead of
  // a separate fetch.
  function buildSubteamsPanel_() {
    var panel = document.createElement('div');
    panel.className = 'org-tree-members-panel';

    var list = document.createElement('div');
    list.className = 'org-tree-members-list';
    panel.appendChild(list);
    renderSubteamsInto_(list);

    var form = document.createElement('form');
    form.className = 'add-form org-tree-add-member-form';
    var row = document.createElement('div');
    row.className = 'row';
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'Subteam name (e.g. Electronics)';
    nameInput.required = true;
    row.appendChild(nameInput);
    form.appendChild(row);
    var addBtn = document.createElement('button');
    addBtn.type = 'submit';
    addBtn.textContent = 'Add subteam';
    form.appendChild(addBtn);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = nameInput.value.trim();
      if (!name) return;
      DB.post('addSubteam', null, { name: name }, function (ok) {
        if (ok) { form.reset(); renderSubteamsInto_(list); }
      });
    });
    panel.appendChild(form);

    return panel;
  }

  function renderSubteamsInto_(list) {
    var subteams = DB.state.data.subteams || [];
    list.innerHTML = '';
    if (!subteams.length) {
      list.innerHTML = '<p class="empty-state">No subteams added yet.</p>';
      return;
    }
    subteams.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'org-tree-member-row';
      var text = document.createElement('span');
      text.textContent = s.name;
      row.appendChild(text);
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'secondary';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', function () {
        DB.post('deleteSubteam', s.id, {}, function () { renderSubteamsInto_(list); });
      });
      row.appendChild(removeBtn);
      list.appendChild(row);
    });
  }

  // Adding a sibling team reuses the mentor passcode already entered at this
  // page's gate (DB.state.passcode) — Code.gs checks it belongs to
  // DB.state.team, and that DB.state.team's org matches the one being
  // targeted, so there's nothing new to authenticate here.
  if (el.newTeamForm) {
    el.newTeamForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = el.newTeamForm.name.value.trim();
      var label = el.newTeamForm.label.value.trim();
      if (!name) return;
      if (el.newTeamResult) el.newTeamResult.innerHTML = '<p class="card-meta">Creating team…</p>';
      DB.createTeam(DB.state.org, DB.state.team, DB.state.passcode, name, label, function (result, err) {
        if (!result) {
          if (el.newTeamResult) el.newTeamResult.innerHTML = '<p class="empty-state">Error: ' + DB.escapeHtml(err) + '</p>';
          return;
        }
        el.newTeamForm.reset();
        if (el.newTeamResult) el.newTeamResult.innerHTML = passcodeResultHtml_(result.teamKey, result.studentPasscode, result.mentorPasscode);
        loadTree();
      });
    });
  }

  // Creating a brand-new organization is the one action still gated behind
  // a site-admin passcode (set once via Code.gs's setSiteAdminPasscode_) —
  // a first-ever org has no existing trusted mentor to gate behind instead.
  if (el.newOrgForm) {
    el.newOrgForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var orgName = el.newOrgForm.orgName.value.trim();
      var name = el.newOrgForm.name.value.trim();
      var label = el.newOrgForm.label.value.trim();
      var siteAdminPasscode = el.newOrgForm.siteAdminPasscode.value;
      if (!orgName || !name) return;
      if (el.newOrgResult) el.newOrgResult.innerHTML = '<p class="card-meta">Creating organization…</p>';
      DB.createOrganization(siteAdminPasscode, orgName, name, label, function (result, err) {
        if (!result) {
          if (el.newOrgResult) el.newOrgResult.innerHTML = '<p class="empty-state">Error: ' + DB.escapeHtml(err) + '</p>';
          return;
        }
        el.newOrgForm.reset();
        if (el.newOrgResult) el.newOrgResult.innerHTML = passcodeResultHtml_(result.teamKey, result.studentPasscode, result.mentorPasscode);
        loadTree();
      });
    });
  }

  // Losing a team's passcodes doesn't require asking us — any mentor
  // already signed into that team can look them up again here.
  if (el.lookupForm) {
    el.lookupForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var teamKey = el.lookupForm.teamKey.value.trim();
      var mentorPasscode = el.lookupForm.mentorPasscode.value;
      if (!teamKey) return;
      if (el.lookupResult) el.lookupResult.innerHTML = '<p class="card-meta">Looking up…</p>';
      DB.getTeamPasscodes(teamKey, mentorPasscode, function (result, err) {
        if (!result) {
          if (el.lookupResult) el.lookupResult.innerHTML = '<p class="empty-state">Error: ' + DB.escapeHtml(err) + '</p>';
          return;
        }
        if (el.lookupResult) el.lookupResult.innerHTML = passcodeResultHtml_(teamKey, result.studentPasscode, result.mentorPasscode);
      });
    });
  }

  function passcodeResultHtml_(teamKey, studentPasscode, mentorPasscode) {
    return '<div class="card"><p class="card-title">' + DB.escapeHtml(teamKey) + '</p>' +
      '<p class="card-notes">Student passcode: <strong>' + DB.escapeHtml(studentPasscode) + '</strong></p>' +
      '<p class="card-notes">Mentor passcode: <strong>' + DB.escapeHtml(mentorPasscode) + '</strong></p>' +
      '<p class="card-meta">Copy these down now — you can look them up again later from this tab.</p></div>';
  }
})();
