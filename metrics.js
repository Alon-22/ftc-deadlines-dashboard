// metrics.js — Metrics tab: a lightweight, closed-vocabulary metric builder
// (group-by + optional equals-filter + one of a small set of aggregations),
// computed entirely client-side from items[]/seasonLog[] already fetched,
// and saved as a named view shared with the whole team via the backend's
// Dashboard Views tab (saveView/deleteView actions).

(function () {
  'use strict';

  var DB = window.DB;
  if (!DB) return;

  var el = {
    form: document.getElementById('metric-form'),
    name: document.getElementById('metric-name'),
    source: document.getElementById('metric-source'),
    groupBy: document.getElementById('metric-groupby'),
    aggregation: document.getElementById('metric-aggregation'),
    filterField: document.getElementById('metric-filter-field'),
    filterValue: document.getElementById('metric-filter-value'),
    list: document.getElementById('metric-views'),
  };
  if (!el.form && !el.list) return; // no Metrics tab on this page

  var FIELDS = {
    subteam: { label: 'Subteam', goals: function (i) { return i.group; }, seasonLog: function (i) { return i.group; } },
    owner: { label: 'Owner', goals: function (i) { return i.owner; }, seasonLog: function (i) { return i.owner; } },
    status: { label: 'Status', goals: function (i) { return i.status; }, seasonLog: null },
    type: { label: 'Type (Team/Personal)', goals: function (i) { return i.subtype; }, seasonLog: function (i) { return i.type; } },
    month: {
      label: 'Month',
      goals: function (i) { return i.targetDate ? monthKey(new Date(i.targetDate)) : null; },
      seasonLog: function (i) { return i.finishedOn ? monthKey(new Date(i.finishedOn)) : null; },
    },
  };

  var AGGREGATIONS = {
    count: { label: 'Count', needsVariance: false },
    onTimeRate: { label: 'On-time rate (%)', needsVariance: true },
    avgVariance: { label: 'Average variance (days)', needsVariance: true },
  };

  var latestData = { items: [], seasonLog: [], views: [] };

  DB.onData(function (data) {
    latestData = data;
    if (el.form) populateFieldSelects();
    if (el.list) renderSavedViews();
  });

  if (el.form) {
    el.form.addEventListener('submit', onSave);
    if (el.source) el.source.addEventListener('change', populateFieldSelects);
  }

  function populateFieldSelects() {
    var source = el.source.value || 'goals';
    var usable = Object.keys(FIELDS).filter(function (key) { return FIELDS[key][source]; });
    fillSelect(el.groupBy, usable.map(function (k) { return { value: k, label: FIELDS[k].label }; }));
    fillSelect(el.filterField, [{ value: '', label: '(no filter)' }].concat(
      usable.map(function (k) { return { value: k, label: FIELDS[k].label }; })
    ));
    var aggOptions = Object.keys(AGGREGATIONS).filter(function (key) {
      return !AGGREGATIONS[key].needsVariance || source === 'seasonLog';
    });
    fillSelect(el.aggregation, aggOptions.map(function (k) { return { value: k, label: AGGREGATIONS[k].label }; }));
  }

  function fillSelect(select, options) {
    if (!select) return;
    select.innerHTML = '';
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      select.appendChild(opt);
    });
  }

  function onSave(e) {
    e.preventDefault();
    var config = {
      source: el.source.value,
      groupBy: el.groupBy.value,
      aggregation: el.aggregation.value,
      filter: el.filterField.value
        ? { field: el.filterField.value, op: 'equals', value: el.filterValue.value.trim() }
        : null,
    };
    var name = el.name.value.trim();
    if (!name) return DB.toast('Name your view first');
    DB.withPasscode(function () {
      DB.post('saveView', null, { name: name, config: config, createdBy: DB.view }, function (ok) {
        if (ok) { el.form.reset(); populateFieldSelects(); DB.load(); }
      });
    });
  }

  function renderSavedViews() {
    el.list.innerHTML = '';
    var views = latestData.views || [];
    if (!views.length) {
      el.list.innerHTML = '<p class="empty-state">No saved metrics yet — build one above.</p>';
      return;
    }
    views.forEach(function (view) {
      el.list.appendChild(buildViewCard(view));
    });
  }

  function buildViewCard(view) {
    var card = document.createElement('div');
    card.className = 'metric-card';

    var header = document.createElement('div');
    header.className = 'metric-card-header';
    var title = document.createElement('span');
    title.textContent = view.name;
    header.appendChild(title);

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'secondary';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () {
      if (!window.confirm('Delete the "' + view.name + '" view? This can\'t be undone.')) return;
      DB.withPasscode(function () {
        DB.post('deleteView', view.id, {}, function (ok) { if (ok) { card.remove(); DB.load(); } });
      });
    });
    header.appendChild(deleteBtn);
    card.appendChild(header);

    var chartEl = document.createElement('div');
    card.appendChild(chartEl);

    if (window.DBCharts) {
      window.DBCharts.renderBarChart(chartEl, computeView(view.config));
    }
    return card;
  }

  function computeView(config) {
    var field = FIELDS[config.groupBy];
    if (!field) return [];
    var sourceKey = config.source === 'seasonLog' ? 'seasonLog' : 'goals';
    var accessor = field[sourceKey];
    if (!accessor) return [];

    var items = sourceKey === 'seasonLog' ? (latestData.seasonLog || []) : (latestData.items || []).filter(function (i) { return i.type === 'goal'; });

    if (config.filter && config.filter.field && FIELDS[config.filter.field]) {
      var filterAccessor = FIELDS[config.filter.field][sourceKey];
      if (filterAccessor) {
        items = items.filter(function (i) {
          return String(filterAccessor(i) || '').toLowerCase() === config.filter.value.toLowerCase();
        });
      }
    }

    var groups = {};
    items.forEach(function (item) {
      var key = accessor(item);
      if (!key) return;
      if (!groups[key]) groups[key] = [];
      groups[key].push(item);
    });

    return Object.keys(groups).sort().map(function (key) {
      return { label: key, value: aggregate(groups[key], config.aggregation) };
    });
  }

  function aggregate(list, aggregation) {
    if (aggregation === 'onTimeRate') {
      var withVariance = list.filter(function (i) { return i.varianceDays != null; });
      if (!withVariance.length) return 0;
      var onTime = withVariance.filter(function (i) { return i.varianceDays <= 0; }).length;
      return Math.round((onTime / withVariance.length) * 100);
    }
    if (aggregation === 'avgVariance') {
      var vals = list.map(function (i) { return i.varianceDays; }).filter(function (v) { return v != null; });
      if (!vals.length) return 0;
      return Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
    }
    return list.length; // count
  }

  function monthKey(date) {
    return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  }
})();
