// notebook.js — Engineering Notebook tab: dated entries (author, title,
// body, optional photos) supporting the FTC judging record requirement.
// Append-only by design, like Mentor Notes — no edit/delete here, the
// notebook is a record of what happened, not a living document. Talks to
// the rest of the app only through window.DB.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    list: document.getElementById('notebook-list'),
    form: document.getElementById('add-notebook-form'),
  };
  if (!el.list && !el.form) return; // no Notebook tab on this page

  var entries = [];
  var pendingPhotoUrl = '';

  DB.onData(function (data) {
    entries = data.notebook || [];
    render();
  });

  function render() {
    if (!el.list) return;
    el.list.innerHTML = '';
    if (!entries.length) {
      el.list.innerHTML = '<p class="empty-state">No notebook entries yet.</p>';
      return;
    }
    entries.forEach(function (n) {
      el.list.appendChild(buildEntry(n));
    });
  }

  function buildEntry(n) {
    var entry = document.createElement('div');
    entry.className = 'note-entry notebook-entry';

    var meta = document.createElement('div');
    meta.className = 'note-meta';
    meta.textContent = (n.date ? new Date(n.date).toLocaleDateString() : '') + ' · ' + (n.author || 'Unknown');
    entry.appendChild(meta);

    if (n.title) {
      var title = document.createElement('strong');
      title.textContent = n.title;
      entry.appendChild(title);
    }

    var body = document.createElement('p');
    body.textContent = n.body || '';
    entry.appendChild(body);

    if (n.photos && n.photos.length) {
      var photos = document.createElement('div');
      photos.className = 'notebook-photos';
      n.photos.forEach(function (url) {
        var link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        var img = document.createElement('img');
        img.src = url;
        img.alt = n.title || 'Notebook photo';
        link.appendChild(img);
        photos.appendChild(link);
      });
      entry.appendChild(photos);
    }

    return entry;
  }

  if (el.form) {
    var photoInput = el.form.querySelector('input[type="file"]');
    var submitBtn = el.form.querySelector('button[type="submit"]');

    el.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fields = {
        author: el.form.author.value.trim(),
        title: el.form.title.value.trim(),
        date: el.form.date.value || new Date().toISOString().slice(0, 10),
        body: el.form.body.value.trim(),
      };
      if (!fields.author || !fields.body) return;

      var file = photoInput && photoInput.files && photoInput.files[0];
      if (!file) {
        submitEntry(fields, []);
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Uploading photo…';
      DB.uploadPhoto(file, function (url, err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add entry';
        if (!url) { DB.toast('Photo upload failed: ' + err); return; }
        submitEntry(fields, [url]);
      });
    });

    function submitEntry(fields, photos) {
      fields.photos = photos;
      DB.post('addNotebookEntry', null, fields, function (ok) {
        if (ok) { el.form.reset(); }
      });
    }
  }
})();
