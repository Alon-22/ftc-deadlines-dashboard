// organizations.js — mentor-only Organizations tab: shows every org and its
// teams (the same public directory app.js's team-select dropdown reads),
// lets a mentor add a sibling team to the org they're already signed into
// (using the mentor passcode they already entered at the gate — see
// Code.gs's createTeam_, which verifies that passcode's team really belongs
// to this org), and lets a site admin create a brand-new organization.
// Every creation displays its freshly generated passcodes once, since
// there's no other way to see them again short of getTeamPasscodes.

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

  loadTree();

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

      if (!org.teams.length) {
        var empty = document.createElement('p');
        empty.className = 'card-meta';
        empty.textContent = 'No teams yet.';
        section.appendChild(empty);
      } else {
        var list = document.createElement('ul');
        list.className = 'org-tree-teams';
        org.teams.forEach(function (team) {
          var item = document.createElement('li');
          item.textContent = team.label + (team.key === DB.state.team ? ' (current)' : '');
          list.appendChild(item);
        });
        section.appendChild(list);
      }

      el.tree.appendChild(section);
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
