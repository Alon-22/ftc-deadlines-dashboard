// inventory.js — Inventory tab: the shared cross-team parts pool. Unlike
// budget.js's per-team parts list, this reads/writes the top-level
// `inventory` collection directly (see app.js's subscribeToTeam and
// WRITE_HANDLERS.*InventoryItem), so every team sees the same stock and can
// check items in or out of it. Talks to the rest of the app only through
// window.DB.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    summary: document.getElementById('inventory-summary'),
    list: document.getElementById('inventory-list'),
    form: document.getElementById('add-inventory-form'),
    search: document.getElementById('inventory-search'),
  };
  if (!el.list && !el.form) return; // no Inventory tab on this page

  var inventory = [];
  var expanded = null;
  var query = '';

  DB.onData(function (data) {
    inventory = data.inventory || [];
    render();
  });

  function render() {
    if (el.summary) renderSummary();
    if (el.list) renderList();
  }

  function renderSummary() {
    var totalQty = inventory.reduce(function (sum, i) { return sum + (i.quantity || 0); }, 0);
    var totalOnOrder = inventory.reduce(function (sum, i) { return sum + (i.onOrder || 0); }, 0);
    el.summary.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'card-meta';
    p.textContent = inventory.length + (inventory.length === 1 ? ' item' : ' items') + ' tracked, ' +
      totalQty + ' total on hand' + (totalOnOrder ? ', ' + totalOnOrder + ' on order' : '');
    el.summary.appendChild(p);
  }

  function renderList() {
    el.list.innerHTML = '';
    var q = query.trim().toLowerCase();
    var shown = inventory.filter(function (i) { return !q || (i.nameLower || '').indexOf(q) !== -1; });
    if (!shown.length) {
      el.list.innerHTML = '<p class="empty-state">' + (inventory.length ? 'No items match that search.' : 'Nothing in inventory yet — add an item below, or mark an ordered part Received to add it automatically.') + '</p>';
      return;
    }
    shown.slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
      .forEach(function (item) { el.list.appendChild(buildRow(item)); });
  }

  function buildRow(item) {
    var row = document.createElement('div');
    row.className = 'checklist-item';

    var header = document.createElement('button');
    header.type = 'button';
    header.className = 'checklist-item-header';
    var qtyBadge = document.createElement('span');
    qtyBadge.className = 'badge ' + (item.quantity > 0 ? 'status-green' : 'status-red');
    qtyBadge.textContent = 'Qty: ' + (item.quantity || 0);
    header.appendChild(qtyBadge);
    if (item.onOrder > 0) {
      var onOrderBadge = document.createElement('span');
      onOrderBadge.className = 'badge status-yellow';
      onOrderBadge.textContent = item.onOrder + ' on order';
      header.appendChild(onOrderBadge);
    }
    var titleSpan = document.createElement('span');
    titleSpan.className = 'checklist-item-title';
    titleSpan.textContent = item.name + (item.location ? ' — ' + item.location : '');
    header.appendChild(titleSpan);
    header.addEventListener('click', function () {
      expanded = expanded === item.id ? null : item.id;
      render();
    });
    row.appendChild(header);

    if (expanded === item.id) row.appendChild(buildEditPanel(item));
    return row;
  }

  function buildEditPanel(item) {
    var panel = document.createElement('div');
    panel.className = 'checklist-item-edit';

    var row1 = document.createElement('div');
    row1.className = 'row';

    var quantityInput = document.createElement('input');
    quantityInput.type = 'number';
    quantityInput.min = '0';
    quantityInput.placeholder = 'Quantity on hand';
    quantityInput.title = 'On hand';
    quantityInput.value = item.quantity || 0;
    quantityInput.addEventListener('change', function () {
      DB.post('updateInventoryItem', item.id, { quantity: quantityInput.value }, function () {});
    });
    row1.appendChild(quantityInput);

    var onOrderInput = document.createElement('input');
    onOrderInput.type = 'number';
    onOrderInput.min = '0';
    onOrderInput.placeholder = 'Quantity on order';
    onOrderInput.title = 'On order (purchased, not yet arrived)';
    onOrderInput.value = item.onOrder || 0;
    onOrderInput.addEventListener('change', function () {
      DB.post('updateInventoryItem', item.id, { onOrder: onOrderInput.value }, function () {});
    });
    row1.appendChild(onOrderInput);

    var locationInput = document.createElement('input');
    locationInput.type = 'text';
    locationInput.placeholder = 'Location (e.g. Shop shelf B)';
    locationInput.value = item.location || '';
    locationInput.addEventListener('change', function () {
      DB.post('updateInventoryItem', item.id, { location: locationInput.value.trim() }, function () {});
    });
    row1.appendChild(locationInput);
    panel.appendChild(row1);

    var lastUpdated = document.createElement('p');
    lastUpdated.className = 'card-notes';
    lastUpdated.textContent = item.lastUpdated ? 'Last updated ' + new Date(item.lastUpdated).toLocaleString() : '';
    panel.appendChild(lastUpdated);

    var row2 = document.createElement('div');
    row2.className = 'row';

    var checkoutQty = document.createElement('input');
    checkoutQty.type = 'number';
    checkoutQty.min = '1';
    checkoutQty.value = '1';
    checkoutQty.title = 'Quantity';
    row2.appendChild(checkoutQty);

    var checkoutBtn = document.createElement('button');
    checkoutBtn.type = 'button';
    checkoutBtn.textContent = 'Check out';
    checkoutBtn.title = 'Take this quantity out of shared inventory for your team to use';
    checkoutBtn.addEventListener('click', function () {
      DB.post('checkoutInventoryItem', item.id, { qty: checkoutQty.value }, function () {});
    });
    row2.appendChild(checkoutBtn);

    var returnBtn = document.createElement('button');
    returnBtn.type = 'button';
    returnBtn.className = 'secondary';
    returnBtn.textContent = 'Return';
    returnBtn.title = 'Put this quantity back into shared inventory';
    returnBtn.addEventListener('click', function () {
      DB.post('returnInventoryItem', item.id, { qty: checkoutQty.value }, function () {});
    });
    row2.appendChild(returnBtn);
    panel.appendChild(row2);

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'secondary';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () {
      if (!window.confirm('Delete "' + item.name + '" from shared inventory?')) return;
      DB.post('deleteInventoryItem', item.id, {}, function () {});
    });
    panel.appendChild(deleteBtn);

    return panel;
  }

  if (el.search) {
    el.search.addEventListener('input', function () {
      query = el.search.value;
      renderList();
    });
  }

  if (el.form) {
    el.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = el.form.name.value.trim();
      if (!name) return;
      DB.post('addInventoryItem', null, {
        name: name,
        quantity: el.form.quantity.value || 0,
        location: el.form.location.value.trim(),
      }, function (ok) {
        if (ok) el.form.reset();
      });
    });
  }
})();
