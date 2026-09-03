// budget.js — Parts & Budget tab: a running list of parts (item, vendor,
// link, cost, qty, status) with a spend summary broken down by status, so
// the team can see wishlist vs. actual committed spend at a glance. Talks
// to the rest of the app only through window.DB.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var STATUSES = ['Wishlist', 'Ordered', 'Received'];

  var el = {
    summary: document.getElementById('budget-summary'),
    list: document.getElementById('budget-list'),
    form: document.getElementById('add-part-form'),
  };
  if (!el.list && !el.form) return; // no Budget tab on this page

  var parts = [];
  var expanded = null;

  DB.onData(function (data) {
    parts = data.parts || [];
    render();
  });

  function money(n) {
    return '$' + n.toFixed(2);
  }

  function render() {
    if (el.summary) renderSummary();
    if (el.list) renderList();
  }

  function renderSummary() {
    var totals = {};
    STATUSES.forEach(function (s) { totals[s] = 0; });
    var grandTotal = 0;
    parts.forEach(function (p) {
      var line = (p.cost || 0) * (p.qty || 1);
      totals[p.status] = (totals[p.status] || 0) + line;
      grandTotal += line;
    });
    el.summary.innerHTML = '';
    var bits = STATUSES.map(function (s) { return s + ': ' + money(totals[s] || 0); });
    bits.push('Total: ' + money(grandTotal));
    var p = document.createElement('p');
    p.className = 'card-meta';
    p.textContent = bits.join(' · ');
    el.summary.appendChild(p);
  }

  function renderList() {
    el.list.innerHTML = '';
    if (!parts.length) {
      el.list.innerHTML = '<p class="empty-state">No parts yet — add one below.</p>';
      return;
    }
    parts.slice().sort(function (a, b) { return (a.item || '').localeCompare(b.item || ''); })
      .forEach(function (p) { el.list.appendChild(buildRow(p)); });
  }

  function statusClass(status) {
    return 'checklist-status-' + (status || 'wishlist').toLowerCase();
  }

  function buildRow(part) {
    var row = document.createElement('div');
    row.className = 'checklist-item';

    var header = document.createElement('button');
    header.type = 'button';
    header.className = 'checklist-item-header';
    var statusBadge = document.createElement('span');
    statusBadge.className = 'badge ' + statusClass(part.status);
    statusBadge.textContent = part.status;
    var titleSpan = document.createElement('span');
    titleSpan.className = 'checklist-item-title';
    titleSpan.textContent = part.item + (part.vendor ? ' — ' + part.vendor : '') +
      ' (' + (part.qty || 1) + ' × ' + money(part.cost || 0) + ')';
    header.appendChild(statusBadge);
    header.appendChild(titleSpan);
    header.addEventListener('click', function () {
      expanded = expanded === part.id ? null : part.id;
      render();
    });
    row.appendChild(header);

    if (expanded === part.id) row.appendChild(buildEditPanel(part));
    return row;
  }

  function buildEditPanel(part) {
    var panel = document.createElement('div');
    panel.className = 'checklist-item-edit';

    var row1 = document.createElement('div');
    row1.className = 'row';

    var statusSelect = document.createElement('select');
    STATUSES.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if ((part.status || 'Wishlist') === s) opt.selected = true;
      statusSelect.appendChild(opt);
    });
    statusSelect.addEventListener('change', function () {
      DB.post('updatePart', part.id, { status: statusSelect.value }, function () {});
    });
    row1.appendChild(statusSelect);

    var vendorInput = document.createElement('input');
    vendorInput.type = 'text';
    vendorInput.placeholder = 'Vendor';
    vendorInput.value = part.vendor || '';
    vendorInput.addEventListener('change', function () {
      DB.post('updatePart', part.id, { vendor: vendorInput.value.trim() }, function () {});
    });
    row1.appendChild(vendorInput);
    panel.appendChild(row1);

    var row2 = document.createElement('div');
    row2.className = 'row';

    var costInput = document.createElement('input');
    costInput.type = 'number';
    costInput.step = '0.01';
    costInput.placeholder = 'Cost each';
    costInput.value = part.cost || 0;
    costInput.addEventListener('change', function () {
      DB.post('updatePart', part.id, { cost: costInput.value }, function () {});
    });
    row2.appendChild(costInput);

    var qtyInput = document.createElement('input');
    qtyInput.type = 'number';
    qtyInput.min = '1';
    qtyInput.placeholder = 'Qty';
    qtyInput.value = part.qty || 1;
    qtyInput.addEventListener('change', function () {
      DB.post('updatePart', part.id, { qty: qtyInput.value }, function () {});
    });
    row2.appendChild(qtyInput);
    panel.appendChild(row2);

    var linkInput = document.createElement('input');
    linkInput.type = 'text';
    linkInput.placeholder = 'Link to vendor page (optional)';
    linkInput.value = part.link || '';
    linkInput.addEventListener('change', function () {
      DB.post('updatePart', part.id, { link: linkInput.value.trim() }, function () {});
    });
    panel.appendChild(linkInput);

    if (part.link) {
      var linkA = document.createElement('a');
      linkA.href = part.link;
      linkA.target = '_blank';
      linkA.rel = 'noopener';
      linkA.textContent = '🔗 View vendor page';
      panel.appendChild(linkA);
    }

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'secondary';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () {
      if (!window.confirm('Delete "' + part.item + '"?')) return;
      DB.post('deletePart', part.id, {}, function () {});
    });
    panel.appendChild(deleteBtn);

    return panel;
  }

  if (el.form) {
    el.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var item = el.form.item.value.trim();
      if (!item) return;
      DB.post('addPart', null, {
        item: item,
        vendor: el.form.vendor.value.trim(),
        cost: el.form.cost.value,
        qty: el.form.qty.value || 1,
        status: el.form.status.value,
      }, function (ok) {
        if (ok) el.form.reset();
      });
    });
  }
})();
