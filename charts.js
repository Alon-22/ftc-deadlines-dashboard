// charts.js — one reusable hand-rolled SVG bar chart, shared by metrics.js
// (the metric builder) and season.js (fixed season-trend charts). No
// dependency — this whole app deliberately stays library-free.

window.DBCharts = (function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function renderBarChart(container, data, opts) {
    opts = opts || {};
    container.innerHTML = '';
    if (!data.length) {
      container.innerHTML = '<p class="empty-state">Nothing to chart yet.</p>';
      return;
    }

    var width = container.clientWidth || 320;
    var chartHeight = opts.height || 160;
    var labelHeight = 28;
    var topPad = 18;
    var svgHeight = chartHeight + labelHeight + topPad;
    var barGap = 10;
    var barWidth = Math.max(16, (width - barGap * (data.length + 1)) / data.length);
    var maxValue = Math.max.apply(null, data.map(function (d) { return d.value; })) || 1;

    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + svgHeight);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', svgHeight);
    svg.classList.add('bar-chart');

    data.forEach(function (d, i) {
      var barHeight = Math.max(1, Math.round((d.value / maxValue) * chartHeight));
      var x = barGap + i * (barWidth + barGap);
      var y = topPad + (chartHeight - barHeight);

      var rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', barWidth);
      rect.setAttribute('height', barHeight);
      rect.setAttribute('rx', 4);
      rect.setAttribute('fill', d.color || (opts.colorFn ? opts.colorFn(d) : 'var(--accent)'));
      svg.appendChild(rect);

      var valueText = document.createElementNS(SVG_NS, 'text');
      valueText.setAttribute('x', x + barWidth / 2);
      valueText.setAttribute('y', y - 5);
      valueText.setAttribute('text-anchor', 'middle');
      valueText.setAttribute('class', 'bar-chart-value');
      valueText.textContent = d.value;
      svg.appendChild(valueText);

      var labelText = document.createElementNS(SVG_NS, 'text');
      labelText.setAttribute('x', x + barWidth / 2);
      labelText.setAttribute('y', topPad + chartHeight + 18);
      labelText.setAttribute('text-anchor', 'middle');
      labelText.setAttribute('class', 'bar-chart-label');
      labelText.textContent = truncateLabel(d.label);
      svg.appendChild(labelText);
    });

    container.appendChild(svg);
  }

  function truncateLabel(label) {
    label = String(label == null ? '' : label);
    return label.length > 12 ? label.slice(0, 11) + '…' : label;
  }

  return { renderBarChart: renderBarChart };
})();
