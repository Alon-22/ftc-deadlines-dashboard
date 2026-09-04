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
    if (el.list) renderList();
    if (el.requestList) renderRequestSection();
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

    var actions = document.createElement('div');
    actions.className = 'card-actions';

    var exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'secondary';
    exportBtn.textContent = 'Export cart (CSV)';
    exportBtn.addEventListener('click', function () { exportVendorCSV(vendor, items); });
    actions.appendChild(exportBtn);

    var orderedBtn = document.createElement('button');
    orderedBtn.type = 'button';
    orderedBtn.className = 'secondary';
    orderedBtn.textContent = 'Mark cart as Ordered';
    orderedBtn.addEventListener('click', function () {
      if (!window.confirm('Mark all ' + items.length + ' item(s) from ' + vendor + ' as Ordered?')) return;
      DB.post('markPartsOrdered', null, { ids: items.map(function (p) { return p.id; }) }, function () {});
    });
    actions.appendChild(orderedBtn);

    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'secondary';
    submitBtn.textContent = 'Submit to coaches';
    submitBtn.addEventListener('click', function () { submitCartToCoaches_(vendor, items, submitBtn); });
    actions.appendChild(submitBtn);

    box.appendChild(actions);
    return box;
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

  function submitCartToCoaches_(vendor, items, btn) {
    var emails = coachEmails_();
    if (!emails.length) {
      DB.toast('No coach emails found — add mentor names + emails to the People tab first.');
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
