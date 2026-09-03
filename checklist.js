// checklist.js — reusable checklist component: a named list of items, each
// with a status (Not started / In progress / Done), an owner, notes, and
// optional photos. Powers the Portfolio tab today; Phase 4's competition-day
// and awards-prep checklists reuse this same file, just pointed at a
// different checklistName via a container's data-checklist-name attribute.
// Talks to the rest of the app only through window.DB.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var STATUSES = ['Not started', 'In progress', 'Done'];

  var containers = document.querySelectorAll('[data-checklist-name]');
  if (!containers.length) return;

  var allItems = [];
  var expanded = null; // id of the item currently expanded for editing

  DB.onData(function (data) {
    allItems = data.checklistItems || [];
    containers.forEach(renderContainer);
  });

  containers.forEach(function (container) {
    container.appendChild(buildAddForm(container.dataset.checklistName));
    if (container.dataset.checklistResettable === 'true') {
      container.appendChild(buildResetButton(container.dataset.checklistName));
    }
    var list = document.createElement('div');
    list.className = 'checklist-list';
    container.appendChild(list);
  });

  function itemsFor(name) {
    return allItems.filter(function (i) { return i.checklistName === name; });
  }

  function renderContainer(container) {
    var name = container.dataset.checklistName;
    var list = container.querySelector('.checklist-list');
    if (!list) return;
    var items = itemsFor(name);
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<p class="empty-state">Nothing here yet.</p>';
      return;
    }
    items.forEach(function (item) { list.appendChild(buildItemRow(item)); });
  }

  function statusClass(status) {
    return 'checklist-status-' + (status || 'Not started').toLowerCase().replace(/\s+/g, '-');
  }

  function buildItemRow(item) {
    var row = document.createElement('div');
    row.className = 'checklist-item';

    var header = document.createElement('button');
    header.type = 'button';
    header.className = 'checklist-item-header';
    var statusBadge = document.createElement('span');
    statusBadge.className = 'badge ' + statusClass(item.status);
    statusBadge.textContent = item.status || 'Not started';
    var titleSpan = document.createElement('span');
    titleSpan.className = 'checklist-item-title';
    titleSpan.textContent = item.title + (item.owner ? ' — ' + item.owner : '');
    header.appendChild(statusBadge);
    header.appendChild(titleSpan);
    header.addEventListener('click', function () {
      expanded = expanded === item.id ? null : item.id;
      document.querySelectorAll('[data-checklist-name]').forEach(renderContainer);
    });
    row.appendChild(header);

    if (expanded === item.id) {
      row.appendChild(buildEditPanel(item));
    }

    return row;
  }

  function buildEditPanel(item) {
    var panel = document.createElement('div');
    panel.className = 'checklist-item-edit';

    var statusSelect = document.createElement('select');
    STATUSES.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if ((item.status || 'Not started') === s) opt.selected = true;
      statusSelect.appendChild(opt);
    });
    statusSelect.addEventListener('change', function () {
      DB.post('updateChecklistItem', item.id, { status: statusSelect.value }, function () {});
    });

    var ownerInput = document.createElement('input');
    ownerInput.type = 'text';
    ownerInput.placeholder = 'Owner';
    ownerInput.value = item.owner || '';
    ownerInput.addEventListener('change', function () {
      DB.post('updateChecklistItem', item.id, { owner: ownerInput.value.trim() }, function () {});
    });

    var row1 = document.createElement('div');
    row1.className = 'row';
    row1.appendChild(statusSelect);
    row1.appendChild(ownerInput);
    panel.appendChild(row1);

    var notesArea = document.createElement('textarea');
    notesArea.placeholder = 'Notes';
    notesArea.value = item.notes || '';
    notesArea.addEventListener('change', function () {
      DB.post('updateChecklistItem', item.id, { notes: notesArea.value.trim() }, function () {});
    });
    panel.appendChild(notesArea);

    if (item.photos && item.photos.length) {
      var photos = document.createElement('div');
      photos.className = 'notebook-photos';
      item.photos.forEach(function (url) {
        var link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        var img = document.createElement('img');
        img.src = url;
        img.alt = item.title;
        link.appendChild(img);
        photos.appendChild(link);
      });
      panel.appendChild(photos);
    }

    var actions = document.createElement('div');
    actions.className = 'row';

    var photoInput = document.createElement('input');
    photoInput.type = 'file';
    photoInput.accept = 'image/*';
    photoInput.addEventListener('change', function () {
      var file = photoInput.files && photoInput.files[0];
      if (!file) return;
      DB.uploadPhoto(file, function (url, err) {
        if (!url) { DB.toast('Photo upload failed: ' + err); return; }
        var photos = (item.photos || []).concat([url]);
        DB.post('updateChecklistItem', item.id, { photos: photos }, function () {});
      });
    });
    actions.appendChild(photoInput);

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'secondary';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () {
      if (!window.confirm('Delete "' + item.title + '"?')) return;
      DB.post('deleteChecklistItem', item.id, {}, function () {});
    });
    actions.appendChild(deleteBtn);

    panel.appendChild(actions);
    return panel;
  }

  function buildResetButton(checklistName) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary checklist-reset-btn';
    btn.textContent = 'Reset all to Not started';
    btn.addEventListener('click', function () {
      if (!window.confirm('Reset every item in this checklist back to "Not started"? Use this between competitions.')) return;
      DB.post('resetChecklistItems', null, { checklistName: checklistName }, function () {});
    });
    return btn;
  }

  function buildAddForm(checklistName) {
    var form = document.createElement('form');
    form.className = 'add-form';

    var row = document.createElement('div');
    row.className = 'row';
    var titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.placeholder = 'New item title';
    titleInput.required = true;
    var ownerInput = document.createElement('input');
    ownerInput.type = 'text';
    ownerInput.placeholder = 'Owner (optional)';
    row.appendChild(titleInput);
    row.appendChild(ownerInput);
    form.appendChild(row);

    var submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.textContent = 'Add item';
    form.appendChild(submitBtn);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var title = titleInput.value.trim();
      if (!title) return;
      DB.post('addChecklistItem', null, {
        checklistName: checklistName,
        title: title,
        owner: ownerInput.value.trim(),
      }, function (ok) {
        if (ok) form.reset();
      });
    });

    return form;
  }
})();
