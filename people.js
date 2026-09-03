// people.js — mentor-only People directory tab: name -> email, so the
// Apps Script daily digest (Code.gs's sendDailyDigest_) knows who to email
// about their due/overdue/stuck goals. Mentor-write per Security Rules;
// only mentor.html includes this file at all.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    list: document.getElementById('people-list'),
    form: document.getElementById('add-person-form'),
  };
  if (!el.list && !el.form) return; // no People tab on this page

  DB.onData(function (data) {
    render(data.people || []);
  });

  function render(people) {
    if (!el.list) return;
    el.list.innerHTML = '';
    if (!people.length) {
      el.list.innerHTML = '<p class="empty-state">No one in the directory yet — add names below so the daily digest email knows who to reach.</p>';
      return;
    }
    people.forEach(function (p) { el.list.appendChild(buildRow(p)); });
  }

  function buildRow(person) {
    var entry = document.createElement('div');
    entry.className = 'note-entry people-row';

    var text = document.createElement('div');
    text.innerHTML = '<strong>' + DB.escapeHtml(person.name) + '</strong><div class="note-meta">' + DB.escapeHtml(person.email) + '</div>';
    entry.appendChild(text);

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'secondary';
    deleteBtn.textContent = 'Remove';
    deleteBtn.addEventListener('click', function () {
      DB.post('deletePerson', person.id, {}, function () {});
    });
    entry.appendChild(deleteBtn);

    return entry;
  }

  if (el.form) {
    el.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = el.form.name.value.trim();
      var email = el.form.email.value.trim();
      if (!name || !email) return;
      DB.post('addPerson', null, { name: name, email: email }, function (ok) {
        if (ok) el.form.reset();
      });
    });
  }
})();
