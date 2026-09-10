// budget.js — Parts & Budget tab: a running list of parts (item, vendor,
// link, cost, qty, status) with a spend summary broken down by status, so
// the team can see wishlist vs. actual committed spend at a glance. Talks
// to the rest of the app only through window.DB.

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var STATUSES = ['Wishlist', 'Out of Stock', 'Ordered', 'Received'];

  var el = {
    summary: document.getElementById('budget-summary'),
    list: document.getElementById('budget-list'),
    form: document.getElementById('add-part-form'),
    formStatus: document.getElementById('add-part-lookup-status'),
    requestList: document.getElementById('budget-request-list'), // mentor.html only
    pendingOrdersList: document.getElementById('budget-pending-orders-list'), // mentor.html only
    ordersList: document.getElementById('budget-orders-list'),
    bulkBar: document.getElementById('budget-bulk-bar'), // mentor.html only
    inventoryMatch: document.getElementById('add-part-inventory-match'),
  };
  if (!el.list && !el.form) return; // no Budget tab on this page

  var parts = [];
  var orders = [];
  var inventory = [];
  var expanded = null;
  var selectedPartIds = {}; // part id -> true, mentor-only bulk-select (see el.bulkBar)

  DB.onData(function (data) {
    parts = data.parts || [];
    orders = data.orders || [];
    inventory = data.inventory || [];
    // Drop selections for parts that no longer exist (deleted, or folded
    // into an order and gone from the plain list) so a stale id never
    // silently rides along into the next bulk apply.
    Object.keys(selectedPartIds).forEach(function (id) {
      if (!parts.some(function (p) { return p.id === id; })) delete selectedPartIds[id];
    });
    render();
  });

  function money(n) {
    return '$' + n.toFixed(2);
  }

  // ===== "Paste a link" auto-fill ==============================================
  // Vendor comes from the URL's hostname — instant, no network call. Title
  // and list price are a best-effort server-side page scrape (Code.gs's
  // lookupPartPrice_, since a browser can't fetch a cross-origin vendor
  // page itself); it can come back empty for sites it can't parse, which
  // is expected, not an error. A few vendors give FTC teams a standing
  // discount off that list price — not something the page itself reports,
  // so it's a small manually-kept table here, applied client-side.

  var KNOWN_VENDORS = {
    'andymark.com': 'AndyMark',
    'servocity.com': 'ServoCity',
    'revrobotics.com': 'REV Robotics',
    'gobilda.com': 'goBILDA',
    'mcmaster.com': 'McMaster-Carr',
    'amazon.com': 'Amazon',
    'banebots.com': 'BaneBots',
    'pitsco.com': 'Pitsco',
    'digikey.com': 'DigiKey',
    'vexrobotics.com': 'VEX Robotics',
  };

  var VENDOR_DISCOUNTS = {
    'gobilda.com': 0.25, // goBILDA's standing FTC/FRC team discount
  };

  function hostnameOf_(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function vendorFromUrl_(url) {
    var host = hostnameOf_(url);
    if (!host) return '';
    if (KNOWN_VENDORS[host]) return KNOWN_VENDORS[host];
    var label = host.split('.')[0];
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  var TAX_RATE_KEY = 'ftc-budget-tax-rate';
  var DEFAULT_TAX_RATE = '7.25'; // California's statewide base sales tax rate — most FTC teams here are CA-based; a saved rate (once someone edits it) always wins
  function savedTaxRate_() {
    try { return localStorage.getItem(TAX_RATE_KEY) || DEFAULT_TAX_RATE; } catch (e) { return DEFAULT_TAX_RATE; }
  }
  function saveTaxRate_(rate) {
    try { localStorage.setItem(TAX_RATE_KEY, rate); } catch (e) { /* private browsing, etc — fine to skip */ }
  }

  // Wires one link input up to auto-fill a vendor input (instant) and, once
  // the lookup returns, cost + optionally item name — plus a small
  // breakdown card (list price, FTC discount if this vendor gives one, a
  // remembered tax rate, live total as qty/tax change) so the mentor sees
  // the real math before it's saved. Never overwrites a value already
  // sitting in a field — pasting a link after you've typed your own
  // vendor/cost/name leaves those alone. statusSelect is optional (the
  // edit panel and add-form both have one); when the page reports the item
  // is out of stock, it gets pushed to "Out of Stock" so it's set aside
  // from the Request for Purchase cart — but only if the status is still
  // at its default "Wishlist", so it never clobbers a status someone
  // already deliberately chose.
  function wireLinkAutofill(linkInput, itemInput, vendorInput, costInput, qtyInput, cardEl, statusSelect) {
    linkInput.addEventListener('change', function () {
      var url = linkInput.value.trim();
      if (cardEl) cardEl.innerHTML = '';
      if (!url) return;

      if (!vendorInput.value.trim()) {
        var vendor = vendorFromUrl_(url);
        if (vendor) {
          vendorInput.value = vendor;
          vendorInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      if (cardEl) cardEl.textContent = 'Looking up price…';
      DB.lookupPartPrice(url, function (info, err) {
        if (cardEl) cardEl.innerHTML = '';
        if (!info || info.price == null) {
          if (cardEl) cardEl.textContent = err ? '' : "Couldn't find a price on that page — enter it manually.";
          return;
        }

        if (itemInput && !itemInput.value.trim() && info.title) {
          itemInput.value = info.title;
          itemInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (statusSelect && info.inStock === false && statusSelect.value === 'Wishlist') {
          statusSelect.value = 'Out of Stock';
          statusSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }

        var discountRate = VENDOR_DISCOUNTS[hostnameOf_(url)] || 0;
        // Round once, right here, and use that same rounded number for the
        // card's own math below — otherwise the card's total (computed from
        // the unrounded value) won't look like it adds up to the rounded
        // line items it's showing right next to it.
        var unitCost = Math.round(info.price * (1 - discountRate) * 100) / 100;
        if (!costInput.value) {
          costInput.value = unitCost.toFixed(2);
          costInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if (cardEl) renderLookupCard_(cardEl, info, discountRate, unitCost, qtyInput);
      });
    });
  }

  function renderLookupCard_(cardEl, info, discountRate, unitCost, qtyInput) {
    cardEl.className = 'lookup-card';

    if (info.title) {
      var titleP = document.createElement('p');
      titleP.className = 'lookup-card-title';
      titleP.textContent = info.title;
      cardEl.appendChild(titleP);
    }

    if (info.inStock === false) {
      var stockP = document.createElement('p');
      stockP.className = 'lookup-card-stock-warning';
      stockP.textContent = 'Currently out of stock — set aside; it\'ll move back to the wishlist automatically once it\'s back in stock.';
      cardEl.appendChild(stockP);
    }

    var listP = document.createElement('p');
    listP.textContent = 'List price: ' + money(info.price) + ' each';
    cardEl.appendChild(listP);

    if (discountRate > 0) {
      var discountP = document.createElement('p');
      discountP.textContent = 'FTC team discount (' + Math.round(discountRate * 100) + '%): ' + money(unitCost) + ' each';
      cardEl.appendChild(discountP);
    }

    var taxRow = document.createElement('div');
    taxRow.className = 'row';
    var taxLabel = document.createElement('span');
    taxLabel.textContent = 'Tax rate:';
    var taxInput = document.createElement('input');
    taxInput.type = 'number';
    taxInput.step = '0.01';
    taxInput.min = '0';
    taxInput.placeholder = '%';
    taxInput.value = savedTaxRate_();
    taxRow.appendChild(taxLabel);
    taxRow.appendChild(taxInput);
    cardEl.appendChild(taxRow);

    var totalP = document.createElement('p');
    totalP.className = 'lookup-card-total';
    cardEl.appendChild(totalP);

    function recompute() {
      var qty = (qtyInput && Number(qtyInput.value)) || 1;
      var taxRate = Number(taxInput.value) || 0;
      var subtotal = unitCost * qty;
      var tax = subtotal * (taxRate / 100);
      totalP.textContent = qty + ' × ' + money(unitCost) + ' = ' + money(subtotal) +
        '  +  tax: ' + money(tax) + '  =  ' + money(subtotal + tax) + ' total';
    }

    taxInput.addEventListener('input', function () { saveTaxRate_(taxInput.value); recompute(); });
    if (qtyInput) qtyInput.addEventListener('input', recompute);
    recompute();
  }

  function render() {
    if (el.summary) renderSummary();
    if (el.bulkBar) renderBulkBar();
    if (el.list) renderList();
    if (el.requestList) renderRequestSection();
    if (el.pendingOrdersList) renderPendingOrders();
    if (el.ordersList) renderOrders();
  }

  // ===== Bulk status change (mentor-only — see el.bulkBar) ===================
  // Selecting parts one at a time to fix a batch of miscategorized rows (a
  // vendor page that reported "in stock" wrong, a cart marked Ordered before
  // it should've been, etc.) doesn't scale past a couple of items — this
  // lets a mentor check off a pile of rows and flip them all to one status
  // in a single write (see app.js's bulkUpdatePartStatus).

  function renderBulkBar() {
    el.bulkBar.innerHTML = '';
    if (!parts.length) return;
    var ids = Object.keys(selectedPartIds);

    var bar = document.createElement('div');
    bar.className = 'bulk-actions-bar';

    var countSpan = document.createElement('span');
    countSpan.className = 'card-meta';
    countSpan.textContent = ids.length + (ids.length === 1 ? ' part selected' : ' parts selected');
    bar.appendChild(countSpan);

    var selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'secondary';
    selectAllBtn.textContent = 'Select all';
    selectAllBtn.addEventListener('click', function () {
      parts.forEach(function (p) { selectedPartIds[p.id] = true; });
      render();
    });
    bar.appendChild(selectAllBtn);

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'secondary';
    clearBtn.textContent = 'Clear selection';
    clearBtn.disabled = !ids.length;
    clearBtn.addEventListener('click', function () {
      selectedPartIds = {};
      render();
    });
    bar.appendChild(clearBtn);

    var statusSelect = document.createElement('select');
    STATUSES.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      statusSelect.appendChild(opt);
    });
    bar.appendChild(statusSelect);

    var applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.textContent = 'Apply to selected';
    applyBtn.disabled = !ids.length;
    applyBtn.addEventListener('click', function () {
      var currentIds = Object.keys(selectedPartIds);
      if (!currentIds.length) return;
      var status = statusSelect.value;
      if (!window.confirm('Set ' + currentIds.length + (currentIds.length === 1 ? ' part' : ' parts') + ' to "' + status + '"?')) return;
      applyBtn.disabled = true;
      applyBtn.textContent = 'Applying…';
      DB.post('bulkUpdatePartStatus', null, { partIds: currentIds, status: status }, function (ok) {
        if (ok) selectedPartIds = {};
        applyBtn.disabled = false;
        applyBtn.textContent = 'Apply to selected';
      });
    });
    bar.appendChild(applyBtn);

    el.bulkBar.appendChild(bar);
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

  // ===== Request for Purchase ==================================================
  // Every Wishlist part, grouped by vendor — a mentor's shopping cart per
  // vendor. Export turns that group into a CSV a purchasing office or
  // treasurer can act on; once it's actually been submitted, "Mark
  // ordered" bulk-flips the whole cart to Ordered in one write.

  function renderRequestSection() {
    var wishlist = parts.filter(function (p) { return (p.status || 'Wishlist') === 'Wishlist'; });
    el.requestList.innerHTML = '';
    if (!wishlist.length) {
      el.requestList.innerHTML = '<p class="empty-state">Nothing on the wishlist to request right now.</p>';
      return;
    }

    var byVendor = {};
    wishlist.forEach(function (p) {
      var key = p.vendor || '(No vendor specified)';
      if (!byVendor[key]) byVendor[key] = [];
      byVendor[key].push(p);
    });

    Object.keys(byVendor).sort().forEach(function (vendor) {
      el.requestList.appendChild(buildVendorCart(vendor, byVendor[vendor]));
    });
  }

  function cartTotal(items) {
    return items.reduce(function (sum, p) { return sum + (p.cost || 0) * (p.qty || 1); }, 0);
  }

  function buildVendorCart(vendor, items) {
    var box = document.createElement('div');
    box.className = 'checklist-item rfp-cart';

    var header = document.createElement('div');
    header.className = 'checklist-item-header';
    var titleSpan = document.createElement('span');
    titleSpan.className = 'checklist-item-title';
    titleSpan.textContent = vendor + ' — ' + items.length + (items.length === 1 ? ' item' : ' items') + ', ' + money(cartTotal(items));
    header.appendChild(titleSpan);
    box.appendChild(header);

    var itemList = document.createElement('ul');
    itemList.className = 'rfp-cart-items';
    var running = 0;
    items.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'rfp-cart-item';

      var nameSpan = document.createElement('span');
      nameSpan.className = 'rfp-cart-item-name';
      nameSpan.textContent = p.item;
      li.appendChild(nameSpan);

      var qtyInput = document.createElement('input');
      qtyInput.type = 'number';
      qtyInput.min = '1';
      qtyInput.title = 'Quantity';
      qtyInput.className = 'rfp-cart-item-qty';
      qtyInput.value = p.qty || 1;
      li.appendChild(qtyInput);

      var xSpan = document.createElement('span');
      xSpan.textContent = '×';
      li.appendChild(xSpan);

      var costInput = document.createElement('input');
      costInput.type = 'number';
      costInput.step = '0.01';
      costInput.min = '0';
      costInput.title = 'Cost each';
      costInput.className = 'rfp-cart-item-cost';
      costInput.value = p.cost || 0;
      li.appendChild(costInput);

      var lineTotal = (p.cost || 0) * (p.qty || 1);
      running += lineTotal;

      var lineTotalSpan = document.createElement('span');
      lineTotalSpan.className = 'rfp-cart-item-linetotal';
      lineTotalSpan.textContent = '= ' + money(lineTotal);
      li.appendChild(lineTotalSpan);

      var runningSpan = document.createElement('span');
      runningSpan.className = 'rfp-cart-item-running';
      runningSpan.textContent = '(running total: ' + money(running) + ')';
      li.appendChild(runningSpan);

      if (p.link) {
        var linkA = document.createElement('a');
        linkA.href = p.link;
        linkA.target = '_blank';
        linkA.rel = 'noopener';
        linkA.textContent = 'Link';
        li.appendChild(linkA);
      }

      qtyInput.addEventListener('change', function () {
        DB.post('updatePart', p.id, { qty: qtyInput.value }, function () {});
      });
      costInput.addEventListener('change', function () {
        DB.post('updatePart', p.id, { cost: costInput.value }, function () {});
      });

      itemList.appendChild(li);
    });
    box.appendChild(itemList);

    // Shipping wasn't tracked anywhere before, which made a cart's real
    // cost easy to undercount — it's a whole-cart charge (not a per-item
    // one), shown as its own clearly-labeled line so the grand total is
    // never ambiguous about whether shipping is folded in.
    var shippingRow = document.createElement('div');
    shippingRow.className = 'row rfp-cart-shipping-row';
    var shippingLabel = document.createElement('span');
    shippingLabel.textContent = 'Shipping:';
    var shippingInput = document.createElement('input');
    shippingInput.type = 'number';
    shippingInput.step = '0.01';
    shippingInput.min = '0';
    shippingInput.value = '0';
    var grandTotalSpan = document.createElement('span');
    grandTotalSpan.className = 'rfp-cart-grand-total';
    function updateGrandTotal() {
      var shipping = Number(shippingInput.value) || 0;
      grandTotalSpan.textContent = 'Total with shipping: ' + money(cartTotal(items) + shipping);
    }
    shippingInput.addEventListener('input', updateGrandTotal);
    updateGrandTotal();
    shippingRow.appendChild(shippingLabel);
    shippingRow.appendChild(shippingInput);
    shippingRow.appendChild(grandTotalSpan);
    box.appendChild(shippingRow);

    var actions = document.createElement('div');
    actions.className = 'card-actions';

    var exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'secondary';
    exportBtn.textContent = 'Export cart (CSV)';
    exportBtn.addEventListener('click', function () { exportVendorCSV(vendor, items); });
    actions.appendChild(exportBtn);

    var requestBtn = document.createElement('button');
    requestBtn.type = 'button';
    requestBtn.className = 'secondary';
    requestBtn.textContent = 'Request order approval';
    requestBtn.title = 'Sends this cart to a mentor to approve before it\'s actually ordered';
    requestBtn.addEventListener('click', function () {
      if (!window.confirm('Send this ' + vendor + ' cart (' + items.length + ' item(s)) to a mentor for approval?')) return;
      DB.post('requestOrderApproval', null, {
        vendor: vendor,
        partIds: items.map(function (p) { return p.id; }),
        shippingCost: shippingInput.value,
      }, function () {});
    });
    actions.appendChild(requestBtn);

    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'secondary';
    submitBtn.textContent = 'Submit to coaches';
    submitBtn.addEventListener('click', function () { submitCartToCoaches_(vendor, items, shippingInput.value, submitBtn); });
    actions.appendChild(submitBtn);

    box.appendChild(actions);
    return box;
  }

  // ===== Pending order approvals (mentor-only review, same pattern as ======
  // goal-deletion approval) ==================================================

  function renderPendingOrders() {
    var pending = orders.filter(function (o) { return o.status === 'Pending Approval'; });
    el.pendingOrdersList.innerHTML = '';
    if (!pending.length) {
      el.pendingOrdersList.innerHTML = '<p class="empty-state">No pending order approvals.</p>';
      return;
    }
    pending.forEach(function (order) { el.pendingOrdersList.appendChild(buildPendingOrderCard(order)); });
  }

  function buildPendingOrderCard(order) {
    var orderParts = parts.filter(function (p) { return (order.partIds || []).indexOf(p.id) !== -1; });
    var box = document.createElement('div');
    box.className = 'checklist-item rfp-cart';

    var header = document.createElement('div');
    header.className = 'checklist-item-header';
    var titleSpan = document.createElement('span');
    titleSpan.className = 'checklist-item-title';
    titleSpan.textContent = order.vendor + ' — ' + orderParts.length + (orderParts.length === 1 ? ' item' : ' items') +
      ', ' + money(cartTotal(orderParts) + (order.shippingCost || 0)) + ' total with shipping';
    header.appendChild(titleSpan);
    box.appendChild(header);

    var itemList = document.createElement('ul');
    itemList.className = 'rfp-cart-items';
    orderParts.forEach(function (p) {
      var li = document.createElement('li');
      li.textContent = p.item + ' — ' + (p.qty || 1) + ' × ' + money(p.cost || 0);
      itemList.appendChild(li);
    });
    box.appendChild(itemList);

    var meta = document.createElement('p');
    meta.className = 'card-notes';
    meta.textContent = 'Requested from the ' + (order.requestedBy || 'student') + ' view' +
      (order.requestedAt ? ' on ' + new Date(order.requestedAt).toLocaleDateString() : '') +
      (order.shippingCost ? ' — shipping: ' + money(order.shippingCost) : '');
    box.appendChild(meta);

    var actions = document.createElement('div');
    actions.className = 'card-actions';
    var approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.textContent = 'Approve order';
    approveBtn.addEventListener('click', function () {
      if (!window.confirm('Approve this order from ' + order.vendor + '? It\'ll move to Orders, where anyone can mark it as ordered once it\'s actually been purchased.')) return;
      DB.post('approveOrder', order.id, {}, function () {});
    });
    var denyBtn = document.createElement('button');
    denyBtn.type = 'button';
    denyBtn.className = 'secondary';
    denyBtn.textContent = 'Deny';
    denyBtn.addEventListener('click', function () {
      DB.post('denyOrder', order.id, {}, function () {});
    });
    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);
    box.appendChild(actions);

    return box;
  }

  // ===== Orders (approved carts — mark as placed, then validate what's =====
  // actually arrived) ==========================================================
  // Three stages share this one list: Approved (a mentor signed off, but no
  // one's actually bought it yet — its parts are still sitting wherever they
  // were, so they're looked up by the order's own partIds, same as the
  // pending-approval card does), Ordered (parts are now linked back via
  // their own orderId, so receiving can be tracked part by part), Received
  // (done). Visible to both views — placing an order and receiving it are
  // ordinary team bookkeeping, not a mentor-only permission decision the way
  // approving the spend is.

  function renderOrders() {
    var active = orders.filter(function (o) { return o.status === 'Approved' || o.status === 'Ordered' || o.status === 'Received'; })
      .sort(function (a, b) { return (b.approvedAt || '').localeCompare(a.approvedAt || ''); });
    el.ordersList.innerHTML = '';
    if (!active.length) {
      el.ordersList.innerHTML = '<p class="empty-state">No orders yet.</p>';
      return;
    }
    active.forEach(function (order) { el.ordersList.appendChild(buildOrderCard(order)); });
  }

  function buildOrderCard(order) {
    var isApproved = order.status === 'Approved';
    var orderParts = isApproved
      ? parts.filter(function (p) { return (order.partIds || []).indexOf(p.id) !== -1; })
      : parts.filter(function (p) { return p.orderId === order.id; });
    var box = document.createElement('div');
    box.className = 'checklist-item rfp-cart';

    var header = document.createElement('div');
    header.className = 'checklist-item-header';
    var titleSpan = document.createElement('span');
    titleSpan.className = 'checklist-item-title';
    if (isApproved) {
      titleSpan.textContent = order.vendor + ' — approved, not yet ordered (' + orderParts.length + (orderParts.length === 1 ? ' item' : ' items') + ')';
    } else {
      var receivedCount = orderParts.filter(function (p) { return p.status === 'Received'; }).length;
      titleSpan.textContent = order.vendor + ' — ' + receivedCount + ' of ' + orderParts.length + ' received' +
        (order.status === 'Received' ? ' (complete)' : '');
    }
    header.appendChild(titleSpan);
    box.appendChild(header);

    var itemList = document.createElement('ul');
    itemList.className = 'rfp-cart-items';
    orderParts.forEach(function (p) {
      var li = document.createElement('li');
      li.className = 'rfp-cart-item';
      var nameSpan = document.createElement('span');
      nameSpan.className = 'rfp-cart-item-name';
      nameSpan.textContent = p.item + ' — ' + (p.qty || 1) + ' × ' + money(p.cost || 0);
      li.appendChild(nameSpan);
      if (!isApproved) {
        if (p.status === 'Received') {
          var doneSpan = document.createElement('span');
          doneSpan.textContent = 'Received';
          li.appendChild(doneSpan);
        } else {
          var receiveBtn = document.createElement('button');
          receiveBtn.type = 'button';
          receiveBtn.className = 'secondary';
          receiveBtn.textContent = 'Mark received';
          receiveBtn.title = 'Adds this part\'s quantity to shared inventory';
          receiveBtn.addEventListener('click', function () {
            DB.post('receivePart', p.id, {}, function () {});
          });
          li.appendChild(receiveBtn);
        }
      }
      itemList.appendChild(li);
    });
    box.appendChild(itemList);

    if (isApproved) {
      var actions = document.createElement('div');
      actions.className = 'card-actions';
      var placedBtn = document.createElement('button');
      placedBtn.type = 'button';
      placedBtn.textContent = 'Mark as ordered';
      placedBtn.title = 'Once you\'ve actually placed this order with the vendor';
      placedBtn.addEventListener('click', function () {
        if (!window.confirm('Mark this ' + order.vendor + ' order as placed? This marks the parts Ordered and creates the paper-trail sheet.')) return;
        DB.post('markOrderPlaced', order.id, {}, function () {});
      });
      actions.appendChild(placedBtn);
      box.appendChild(actions);
    }

    if (order.sheetUrl) {
      var linkA = document.createElement('a');
      linkA.href = order.sheetUrl;
      linkA.target = '_blank';
      linkA.rel = 'noopener';
      linkA.textContent = 'View purchase sheet';
      box.appendChild(linkA);
    }

    return box;
  }

  // Warns while adding a new RFP part if something with a similar name is
  // already sitting in shared inventory with stock on hand — a fuzzy
  // (substring, either direction) check, unlike the exact match used when
  // folding a received part into inventory, since this is just a "maybe
  // check first" nudge, not something that merges records.
  function wireInventoryCheck(itemInput, statusEl) {
    if (!itemInput || !statusEl) return;
    itemInput.addEventListener('input', function () {
      var q = itemInput.value.trim().toLowerCase();
      if (q.length < 3) { statusEl.textContent = ''; return; }
      var match = inventory.filter(function (i) {
        return (i.quantity || 0) > 0 && i.nameLower && (i.nameLower.indexOf(q) !== -1 || q.indexOf(i.nameLower) !== -1);
      })[0];
      statusEl.textContent = match
        ? 'Already have ' + match.quantity + ' of "' + match.name + '"' + (match.location ? ' in ' + match.location : '') + ' — check before ordering more.'
        : '';
    });
  }

  // Recipients are resolved from data the app already has, not a new
  // setting: "coaches" = People-directory entries whose name matches this
  // team's mentor roster (the same roster that already decides who can see
  // a mentor-owned goal). A mentor just needs to be in the People tab once.
  function coachEmails_() {
    var mentors = (DB.state.data.mentors || []).map(function (m) { return m.trim().toLowerCase(); });
    var people = DB.state.data.people || [];
    return people
      .filter(function (p) { return mentors.indexOf((p.name || '').trim().toLowerCase()) !== -1; })
      .map(function (p) { return p.email; })
      .filter(Boolean);
  }

  function purchaseRequestEmailBody_(vendor, items, teamLabel) {
    var lines = ['Purchase Request', 'Team: ' + teamLabel, 'Vendor: ' + vendor, 'Date: ' + new Date().toLocaleDateString(), ''];
    items.forEach(function (p) {
      var lineTotal = (p.cost || 0) * (p.qty || 1);
      lines.push('- ' + p.item + ' — ' + (p.qty || 1) + ' × ' + money(p.cost || 0) + ' = ' + money(lineTotal) + (p.link ? ' (' + p.link + ')' : ''));
    });
    lines.push('', 'Total: ' + money(cartTotal(items)));
    return lines.join('\n');
  }

  function submitCartToCoaches_(vendor, items, shippingCost, btn) {
    var emails = coachEmails_();
    if (!emails.length) {
      // No coach email on file to actually send to — the point of this
      // button is getting a mentor's attention, so fall back to the same
      // in-app request a mentor already checks (Pending order approvals)
      // rather than just failing with nothing to show for it.
      btn.disabled = true;
      btn.textContent = 'Sending…';
      DB.post('requestOrderApproval', null, {
        vendor: vendor,
        partIds: items.map(function (p) { return p.id; }),
        shippingCost: shippingCost,
      }, function (ok) {
        btn.disabled = false;
        btn.textContent = 'Submit to coaches';
        DB.toast(ok ? 'No coach emails on file — sent to the mentor dashboard for approval instead.' : 'Could not send for approval.');
      });
      return;
    }
    var teamLabel = (DB.teamConfig() || {}).label || DB.state.team || '';
    var subject = 'Purchase Request: ' + vendor + ' — ' + teamLabel;
    var body = purchaseRequestEmailBody_(vendor, items, teamLabel);
    btn.disabled = true;
    btn.textContent = 'Sending…';
    DB.sendPurchaseRequestEmail(emails, subject, body, function (ok, err) {
      btn.disabled = false;
      btn.textContent = 'Submit to coaches';
      DB.toast(ok ? 'Sent to ' + emails.length + ' coach' + (emails.length === 1 ? '' : 'es') : 'Could not send: ' + err);
    });
  }

  function csvField_(value) {
    var s = String(value == null ? '' : value);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function exportVendorCSV(vendor, items) {
    var teamLabel = (DB.teamConfig() || {}).label || DB.state.team || '';
    var lines = [];
    lines.push([csvField_('Purchase Request')].join(','));
    lines.push([csvField_('Team'), csvField_(teamLabel)].join(','));
    lines.push([csvField_('Vendor'), csvField_(vendor)].join(','));
    lines.push([csvField_('Date'), csvField_(new Date().toLocaleDateString())].join(','));
    lines.push('');
    lines.push(['Item', 'Link', 'Qty', 'Cost Each', 'Line Total'].map(csvField_).join(','));
    items.forEach(function (p) {
      var lineTotal = (p.cost || 0) * (p.qty || 1);
      lines.push([p.item, p.link || '', p.qty || 1, (p.cost || 0).toFixed(2), lineTotal.toFixed(2)].map(csvField_).join(','));
    });
    lines.push('');
    lines.push(['', '', '', 'Total', cartTotal(items).toFixed(2)].map(csvField_).join(','));

    var csv = lines.join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var safeVendor = vendor.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'vendor';
    a.href = url;
    a.download = 'purchase-request-' + safeVendor + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function statusClass(status) {
    return 'checklist-status-' + (status || 'wishlist').toLowerCase().replace(/\s+/g, '-');
  }

  function buildRow(part) {
    var row = document.createElement('div');
    row.className = 'checklist-item';

    var headerRow = document.createElement('div');
    headerRow.className = 'checklist-item-header-row';

    // Bulk-select checkbox sits next to (not inside) the header button —
    // interactive controls can't nest inside a <button>, and keeping it a
    // sibling means a click on the checkbox never bubbles into the button's
    // own expand/collapse handler.
    if (el.bulkBar) {
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'bulk-select-checkbox';
      checkbox.title = 'Select for bulk status change';
      checkbox.checked = !!selectedPartIds[part.id];
      checkbox.addEventListener('change', function () {
        if (checkbox.checked) selectedPartIds[part.id] = true;
        else delete selectedPartIds[part.id];
        render();
      });
      headerRow.appendChild(checkbox);
    }

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
    headerRow.appendChild(header);
    row.appendChild(headerRow);

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
    linkInput.placeholder = 'Link to vendor page (optional) — paste one to auto-fill vendor + cost above';
    linkInput.value = part.link || '';
    linkInput.addEventListener('change', function () {
      DB.post('updatePart', part.id, { link: linkInput.value.trim() }, function () {});
    });
    panel.appendChild(linkInput);

    var linkStatus = document.createElement('div');
    linkStatus.className = 'card-meta';
    panel.appendChild(linkStatus);
    wireLinkAutofill(linkInput, null, vendorInput, costInput, qtyInput, linkStatus, statusSelect);

    if (part.link) {
      var linkA = document.createElement('a');
      linkA.href = part.link;
      linkA.target = '_blank';
      linkA.rel = 'noopener';
      linkA.textContent = 'View vendor page';
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
    if (el.form.link) wireLinkAutofill(el.form.link, el.form.item, el.form.vendor, el.form.cost, el.form.qty, el.formStatus, el.form.status);
    if (el.form.item && el.inventoryMatch) wireInventoryCheck(el.form.item, el.inventoryMatch);

    el.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var item = el.form.item.value.trim();
      if (!item) return;
      DB.post('addPart', null, {
        item: item,
        link: el.form.link ? el.form.link.value.trim() : '',
        vendor: el.form.vendor.value.trim(),
        cost: el.form.cost.value,
        qty: el.form.qty.value || 1,
        status: el.form.status.value,
      }, function (ok) {
        if (ok) { el.form.reset(); if (el.formStatus) el.formStatus.textContent = ''; }
      });
    });
  }
})();
