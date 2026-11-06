(function () {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const DB_NAME = 'fleet-intelligence-db';
  const DB_VERSION = 1;
  const STORE_DAYS = 'days';
  const STORE_META = 'meta';
  const CONFIG_KEY = 'fleet-intelligence-status-config-v1';
  const POLL_MS = 60 * 1000;
  const state = {
    db: null,
    days: [],
    statusConfig: readStatusConfig(),
    charts: {},
    selectedDetailDate: null,
    toastTimer: null,
    remoteVersion: window.FLEET_SUMMARY?.version || null,
    sourceLabel: 'Dados carregados'
  };

  function readStatusConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }

  function persistStatusConfig() {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(state.statusConfig)); } catch (_) { /* storage may be disabled */ }
  }

  function showToast(message) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatInt(value) {
    return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(Number(value) || 0);
  }

  function formatPct(value) {
    return `${(Number(value) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const [year, month, day] = iso.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('pt-BR');
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function openDatabase() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_DAYS)) db.createObjectStore(STORE_DAYS, { keyPath: 'date' });
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }

  function dbRequest(storeName, mode, method, value) {
    if (!state.db) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const request = value === undefined ? store[method]() : store[method](value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getStoredDays() {
    try { return (await dbRequest(STORE_DAYS, 'readonly', 'getAll')) || []; }
    catch (_) { return []; }
  }

  async function putDay(day) {
    try { await dbRequest(STORE_DAYS, 'readwrite', 'put', day); } catch (_) { /* memory remains available */ }
  }

  async function putMeta(key, value) {
    try { await dbRequest(STORE_META, 'readwrite', 'put', { key, value }); } catch (_) { /* optional metadata */ }
  }

  async function getMeta(key) {
    try { return await dbRequest(STORE_META, 'readonly', 'get', key).then((r) => r?.value); }
    catch (_) { return null; }
  }

  async function mergeRemoteSummary(remote) {
    const remoteDays = Array.isArray(remote?.days) ? remote.days : [];
    const stored = await getStoredDays();
    const map = new Map(stored.map((day) => [day.date, day]));
    remoteDays.forEach((day) => {
      const previous = map.get(day.date);
      const sameBreakdown = previous && JSON.stringify(previous.segments || []) === JSON.stringify(day.segments || []);
      const merged = { ...previous, ...day };
      if (!Array.isArray(day.vehicles) && sameBreakdown && Array.isArray(previous.vehicles)) merged.vehicles = previous.vehicles;
      map.set(day.date, merged);
    });
    state.days = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
    for (const day of state.days) await putDay(day);
    if (remote?.version) {
      await putMeta('remoteVersion', remote.version);
      state.remoteVersion = remote.version;
    }
    $('#lastUpdated').textContent = formatDateTime(remote?.generatedAt);
    $('#syncStatus').textContent = remoteDays.length ? 'DADOS SINCRONIZADOS' : 'AGUARDANDO PLANILHA';
    populateFilters();
    renderAll();
    renderStatusConfig();
  }

  async function initializeData() {
    // Restaura primeiro o último histórico local; o resumo publicado depois o atualiza.
    const stored = await getStoredDays();
    if (stored.length) {
      state.days = stored.sort((a, b) => a.date.localeCompare(b.date));
      populateFilters();
      renderAll();
    }
    await mergeRemoteSummary(window.FLEET_SUMMARY || { days: [] });
    if (!state.db) {
      showToast('Armazenamento persistente indisponível. Os dados ficarão apenas nesta sessão.');
    }
  }

  function allSegments(days) {
    const list = [];
    (days || []).forEach((d) => {
      if (Array.isArray(d.segments)) list.push(...d.segments);
    });
    return list;
  }

  function uniqueSorted(values) {
    return Array.from(new Set(values.filter((v) => v && v !== 'Não informado'))).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  function populateSelect(id, values, allLabel) {
    const select = $(id);
    const old = select.value;
    select.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>` + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (values.includes(old)) select.value = old;
  }

  function populateFilters() {
    const days = state.days;
    const currentDay = $('#dayFilter').value;
    $('#dayFilter').innerHTML = '<option value="">Todos os dias</option>' + days.map((d) => `<option value="${d.date}">${formatDate(d.date)}</option>`).join('');
    if (days.some((d) => d.date === currentDay)) $('#dayFilter').value = currentDay;
    const segments = allSegments(days);
    const bases = uniqueSorted(segments.map((s) => s.base).concat(days.flatMap((d) => (d.vehicles || []).map((v) => v.base))));
    const rentals = uniqueSorted(segments.map((s) => s.locadora).concat(days.flatMap((d) => (d.vehicles || []).map((v) => v.locadora))));
    populateSelect('#baseFilter', bases, 'Todas as bases');
    populateSelect('#rentalFilter', rentals, 'Todas as locadoras');
  }

  function activeFilters() {
    return {
      from: $('#dateFrom').value,
      to: $('#dateTo').value,
      day: $('#dayFilter').value,
      base: $('#baseFilter').value,
      locadora: $('#rentalFilter').value
    };
  }

  function getEntries() {
    const filters = activeFilters();
    return state.days.filter((day) => {
      if (filters.from && day.date < filters.from) return false;
      if (filters.to && day.date > filters.to) return false;
      if (filters.day && day.date !== filters.day) return false;
      return true;
    }).map((day) => ({ day, metrics: FleetCore.metricsFromDay(day, { base: filters.base, locadora: filters.locadora }, state.statusConfig) }))
      .filter((entry) => entry.metrics.fleetTotal > 0);
  }

  function compareDelta(current, previous, inverseGood) {
    if (!previous || current === previous) return '<span class="neutral">Sem alteração em relação ao dia anterior</span>';
    const diff = current - previous;
    const good = inverseGood ? diff < 0 : diff > 0;
    const arrow = diff > 0 ? '↑' : '↓';
    return `<span class="${good ? 'positive' : 'negative'}">${arrow} ${formatInt(Math.abs(diff))} vs. dia anterior</span>`;
  }

  function comparePercent(current, previous, inverseGood) {
    if (!previous || Math.abs(current - previous) < 0.005) return '<span class="neutral">Sem alteração em relação ao dia anterior</span>';
    const diff = current - previous;
    const good = inverseGood ? diff < 0 : diff > 0;
    const arrow = diff > 0 ? '↑' : '↓';
    return `<span class="${good ? 'positive' : 'negative'}">${arrow} ${Math.abs(diff).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} p.p. vs. dia anterior</span>`;
  }

  function setKpi(id, footId, value, foot) {
    $(id).textContent = value;
    $(footId).innerHTML = foot;
  }

  function renderCards(entries) {
    const latest = entries[entries.length - 1];
    if (!latest) {
      ['kpiFleet','kpiMaintenance','kpiPhysical','kpiPhysicalRate','kpiCapacity','kpiCapacityRate','kpiOther'].forEach((id) => { $(`#${id}`).textContent = '—'; });
      ['footFleet','footMaintenance','footPhysical','footPhysicalRate','footCapacity','footCapacityRate','footOther'].forEach((id) => { $(`#${id}`).textContent = 'Sem dados para os filtros'; });
      $('#positionNote').textContent = 'Sem dados no período selecionado';
      return;
    }
    const previous = state.days.filter((d) => d.date < latest.day.date).slice(-1)[0];
    const filters = activeFilters();
    const prevMetrics = previous ? FleetCore.metricsFromDay(previous, { base: filters.base, locadora: filters.locadora }, state.statusConfig) : null;
    const m = latest.metrics;
    setKpi('#kpiFleet', '#footFleet', formatInt(m.fleetTotal), prevMetrics ? compareDelta(m.fleetTotal, prevMetrics.fleetTotal, false) : 'Veículos identificados no dia');
    const stoppedNow = Number(m.maintenanceSinistroTotal ?? (m.maintenance + (m.sinistro || 0)));
    const stoppedPrevious = prevMetrics ? Number(prevMetrics.maintenanceSinistroTotal ?? (prevMetrics.maintenance + (prevMetrics.sinistro || 0))) : 0;
    setKpi('#kpiMaintenance', '#footMaintenance', formatInt(stoppedNow), `Manutenção: <strong>${formatInt(m.maintenance)}</strong> · Sinistro: <strong>${formatInt(m.sinistro || 0)}</strong> · ${formatPct(m.fleetTotal ? stoppedNow / m.fleetTotal * 100 : 0)} da frota · ${prevMetrics ? compareDelta(stoppedNow, stoppedPrevious, true) : 'Sem dia anterior'}`);
    setKpi('#kpiPhysical', '#footPhysical', formatInt(m.physicalAvailable), `${formatPct(m.physicalPercent)} da frota · ${prevMetrics ? compareDelta(m.physicalAvailable, prevMetrics.physicalAvailable, false) : 'Sem dia anterior'}`);
    setKpi('#kpiPhysicalRate', '#footPhysicalRate', formatPct(m.physicalPercent), prevMetrics ? comparePercent(m.physicalPercent, prevMetrics.physicalPercent, false) : 'Disponibilidade sem manutenção');
    setKpi('#kpiCapacity', '#footCapacity', formatInt(m.operationalCapacity), `${formatPct(m.operationalPercent)} da frota · ${prevMetrics ? compareDelta(m.operationalCapacity, prevMetrics.operationalCapacity, false) : 'Sem dia anterior'}`);
    setKpi('#kpiCapacityRate', '#footCapacityRate', formatPct(m.operationalPercent), prevMetrics ? comparePercent(m.operationalPercent, prevMetrics.operationalPercent, false) : 'Capacidade real de operação');
    setKpi('#kpiOther', '#footOther', formatInt(m.unavailableOther), `Além de manutenção e sinistro · ${prevMetrics ? compareDelta(m.unavailableOther, prevMetrics.unavailableOther, true) : 'Sem dia anterior'}`);
    $('#positionNote').textContent = `Posição em ${formatDate(latest.day.date)} · ${filters.base || 'Todas as bases'}`;
  }

  function renderAlert(entries) {
    const latest = entries[entries.length - 1];
    const target = $('#alertArea');
    if (!latest || !latest.metrics.unknownStatuses?.length) { target.innerHTML = ''; return; }
    const names = latest.metrics.unknownStatuses.map((x) => `${x.status} (${x.count})`).join(', ');
    target.innerHTML = `<div class="alert-banner"><strong>⚠ Classificação pendente:</strong><span>${escapeHtml(names)}. Esses status são considerados indisponíveis até serem classificados na seção “Configuração de status”.</span></div>`;
  }

  function trendLine(values) {
    if (values.length < 2) return values.map(() => null);
    const n = values.length;
    const xs = values.map((_, i) => i);
    const avgX = xs.reduce((a, b) => a + b, 0) / n;
    const avgY = values.reduce((a, b) => a + b, 0) / n;
    let numerator = 0, denominator = 0;
    xs.forEach((x, i) => { numerator += (x - avgX) * (values[i] - avgY); denominator += (x - avgX) ** 2; });
    const slope = denominator ? numerator / denominator : 0;
    const intercept = avgY - slope * avgX;
    return xs.map((x) => intercept + slope * x);
  }

  function chartBaseOptions(isPercent) {
    return {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#718198', usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, padding: 18, font: { family: 'DM Sans', size: 10 } } },
        tooltip: { backgroundColor: '#153650', titleFont: { family: 'DM Sans', weight: '700' }, bodyFont: { family: 'DM Sans', size: 10 }, padding: 10, callbacks: { label: (ctx) => `${ctx.dataset.label}: ${isPercent ? formatPct(ctx.parsed.y) : formatInt(ctx.parsed.y)}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#8b99a8', font: { family: 'DM Sans', size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { beginAtZero: true, grid: { color: '#edf1f5' }, ticks: { color: '#8b99a8', font: { family: 'DM Sans', size: 9 }, callback: (v) => isPercent ? `${v}%` : v } }
      }
    };
  }

  function setChart(id, type, data, options) {
    if (!window.Chart) return;
    const canvas = $(id);
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
    state.charts[id] = new Chart(canvas, { type, data, options });
  }

  function renderCharts(entries) {
    const labels = entries.map((e) => formatDate(e.day.date).slice(0, 5));
    const physical = entries.map((e) => Number(e.metrics.physicalPercent.toFixed(2)));
    const capacity = entries.map((e) => Number(e.metrics.operationalPercent.toFixed(2)));
    const maintenance = entries.map((e) => e.metrics.maintenance);
    const sinistro = entries.map((e) => e.metrics.sinistro || 0);
    const fleet = entries.map((e) => e.metrics.fleetTotal);
    const operational = entries.map((e) => e.metrics.operationalCapacity);
    const physicalPoints = physical.map((v, i) => i > 0 && v < physical[i - 1] ? '#d05c63' : '#249b73');
    const pctOptions = chartBaseOptions(true);
    const countOptions = chartBaseOptions(false);
    setChart('#chartPhysical', 'line', { labels, datasets: [
      { label: 'Disponibilidade física', data: physical, borderColor: '#279a74', backgroundColor: 'rgba(39,154,116,.10)', fill: true, tension: .28, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: physicalPoints },
      { label: 'Tendência', data: trendLine(physical), borderColor: '#8eb9a9', borderDash: [5, 5], pointRadius: 0, borderWidth: 1.5, tension: 0 }
    ] }, pctOptions);
    setChart('#chartCapacity', 'line', { labels, datasets: [
      { label: 'Capacidade de utilização', data: capacity, borderColor: '#3b80ca', backgroundColor: 'rgba(59,128,202,.10)', fill: true, tension: .28, borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: '#3b80ca' }
    ] }, pctOptions);
    setChart('#chartCompare', 'line', { labels, datasets: [
      { label: 'Disponibilidade física', data: physical, borderColor: '#249b73', backgroundColor: 'transparent', tension: .28, borderWidth: 2, pointRadius: 2.5 },
      { label: 'Capacidade de utilização', data: capacity, borderColor: '#3b80ca', backgroundColor: 'transparent', tension: .28, borderWidth: 2, pointRadius: 2.5 }
    ] }, pctOptions);
    setChart('#chartMaintenance', 'bar', { labels, datasets: [
      { label: 'Manutenção', data: maintenance, backgroundColor: '#e2ad4c', hoverBackgroundColor: '#ca9330', borderRadius: 4, maxBarThickness: 28, stack: 'parados' },
      { label: 'Sinistro', data: sinistro, backgroundColor: '#d66a72', hoverBackgroundColor: '#b94e58', borderRadius: 4, maxBarThickness: 28, stack: 'parados' }
    ] }, { ...countOptions, scales: { ...countOptions.scales, x: { ...countOptions.scales.x, stacked: true }, y: { ...countOptions.scales.y, stacked: true } } });
    setChart('#chartVolume', 'bar', { labels, datasets: [
      { label: 'Frota total', data: fleet, backgroundColor: '#dbe5ef', borderRadius: 4, maxBarThickness: 25 },
      { label: 'Capacidade de utilização', data: operational, backgroundColor: '#3d8fca', borderRadius: 4, maxBarThickness: 25 }
    ] }, countOptions);
    if (!window.Chart) {
      document.querySelectorAll('.chart-wrap').forEach((node) => { node.innerHTML = '<div class="empty-cell">Não foi possível carregar a biblioteca de gráficos. Verifique a conexão com a internet.</div>'; });
    }
  }

  function renderHistory(entries) {
    const term = normalizeText($('#tableSearch').value);
    const body = $('#historyBody');
    const rows = entries.filter(({ day, metrics }) => !term || [formatDate(day.date), day.sheetName, metrics.fleetTotal, metrics.maintenance, metrics.sinistro, metrics.maintenanceSinistroTotal, metrics.physicalAvailable, metrics.unavailableOperation, metrics.operationalCapacity].join(' ').toLowerCase().includes(term));
    if (!rows.length) body.innerHTML = '<tr><td colspan="9" class="empty-cell">Nenhum registro encontrado para os filtros informados.</td></tr>'; 
    else body.innerHTML = rows.slice().reverse().map(({ day, metrics }) => `<tr data-date="${day.date}" class="${state.selectedDetailDate === day.date ? 'selected-row' : ''}">
      <td class="date-cell">${formatDate(day.date)}</td><td class="num">${formatInt(metrics.fleetTotal)}</td><td class="num">${formatInt(metrics.maintenance)}</td><td class="num">${formatInt(metrics.sinistro || 0)}</td><td class="num">${formatInt(metrics.physicalAvailable)}</td><td class="num">${formatPct(metrics.physicalPercent)}</td><td class="num">${formatInt(metrics.unavailableOperation)}</td><td class="num">${formatInt(metrics.operationalCapacity)}</td><td class="num">${formatPct(metrics.operationalPercent)}</td></tr>`).join('');
    $('#historyCount').textContent = `${rows.length} dia(s) no histórico exibido`;
    $('#chartPeriod').textContent = rows.length ? `${formatDate(rows[0].day.date)} a ${formatDate(rows[rows.length - 1].day.date)}` : 'Sem período';
  }

  function normalizeText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function getStatusClassLabel(status) {
    const key = FleetCore.normalize(status);
    if (key.includes('MANUTENCAO')) return 'Manutenção';
    if (key.includes('SINISTRO')) return 'Sinistro';
    if (key.includes('APREEND')) return 'Apreensão';
    if (key.includes('DRIVER') || key.includes('SEM DRIVER')) return 'Indisponibilidade de motorista';
    if (key.includes('FOLGA') || key.includes('ABS')) return 'Folga / escala';
    if (key === 'ATIVA' || key.includes('RESERVA / ATIVA') || key.includes('ATIVA - RESERVA')) return 'Disponível';
    return 'Outros motivos';
  }

  function detailSegments(day, filters) {
    if (Array.isArray(day.vehicles) && day.vehicles.length) {
      const selected = day.vehicles.filter((v) => (!filters.base || v.base === filters.base) && (!filters.locadora || v.locadora === filters.locadora));
      const groups = new Map();
      selected.forEach((v) => {
        const status = v.status || 'STATUS NÃO INFORMADO';
        const key = [status, v.base || 'Não informado', v.locadora || 'Não informado'].join('\u001f');
        if (!groups.has(key)) groups.set(key, { status, base: v.base || 'Não informado', locadora: v.locadora || 'Não informado', plates: [] });
        groups.get(key).plates.push(v.plate);
      });
      return Array.from(groups.values()).map((g) => ({ ...g, count: g.plates.length }));
    }
    return (day.segments || []).filter((s) => (!filters.base || s.base === filters.base) && (!filters.locadora || s.locadora === filters.locadora))
      .map((s) => ({ ...s, plates: [] }));
  }

  function statusOrder(status) {
    const category = getStatusClassLabel(status);
    return ({ 'Manutenção': 0, 'Indisponibilidade de motorista': 1, 'Folga / escala': 2, 'Apreensão': 3, 'Sinistro': 4, 'Outros motivos': 5, 'Disponível': 6 })[category] ?? 8;
  }

  function renderDetails(entries) {
    const filters = activeFilters();
    let day = state.days.find((d) => d.date === state.selectedDetailDate);
    const allowedDates = new Set(entries.map((x) => x.day.date));
    if (!day || !allowedDates.has(day.date)) day = entries[entries.length - 1]?.day || null;
    if (!day) {
      $('#detailDate').textContent = '—';
      $('#detailSubtitle').textContent = 'Nenhuma data disponível para a seleção.';
      $('#detailBody').innerHTML = '<tr><td colspan="6" class="empty-cell">Sem dados para detalhar.</td></tr>';
      $('#detailSummary').innerHTML = '';
      $('#detailNotice').hidden = true;
      return;
    }
    state.selectedDetailDate = day.date;
    $('#detailDate').textContent = formatDate(day.date);
    $('#detailSubtitle').textContent = `Detalhamento da posição de ${formatDate(day.date)} · ${day.sheetName}`;
    const groups = detailSegments(day, filters).sort((a, b) => statusOrder(a.status) - statusOrder(b.status) || a.status.localeCompare(b.status, 'pt-BR'));
    const totals = FleetCore.metricsFromDay(day, { base: filters.base, locadora: filters.locadora }, state.statusConfig);
    $('#detailSummary').innerHTML = [
      ['Frota', totals.fleetTotal], ['Parados (manutenção + sinistro)', totals.maintenanceSinistroTotal || (totals.maintenance + (totals.sinistro || 0))], ['Manutenção', totals.maintenance], ['Sinistro', totals.sinistro || 0], ['Sem motorista', groups.filter((g) => FleetCore.normalize(g.status).includes('DRIVER')).reduce((a, g) => a + g.count, 0)],
      ['Apreensão', groups.filter((g) => FleetCore.normalize(g.status).includes('APREEND')).reduce((a, g) => a + g.count, 0)], ['Outros indisponíveis', totals.unavailableOther]
    ].map(([label, value]) => `<span class="detail-chip">${escapeHtml(label)} <strong>${formatInt(value)}</strong></span>`).join('');
    const hasPlates = Array.isArray(day.vehicles);
    $('#detailNotice').hidden = hasPlates;
    if (!hasPlates) $('#detailNotice').textContent = 'Esta visualização online utiliza dados consolidados e não carrega placas individualizadas. Importe a planilha nesta sessão para consultar as placas; o detalhamento ficará salvo apenas no navegador utilizado.';
    $('#detailBody').innerHTML = groups.length ? groups.map((g) => {
      const plates = g.plates || [];
      const plateHtml = plates.length ? plates.map((p) => `<span class="plate-tag">${escapeHtml(p)}</span>`).join('') : '<span class="detail-muted">Disponível após importação local</span>';
      return `<tr><td><span class="status-pill">${escapeHtml(getStatusClassLabel(g.status))}</span></td><td>${escapeHtml(g.status)}</td><td>${escapeHtml(g.base)}</td><td>${escapeHtml(g.locadora)}</td><td class="num">${formatInt(g.count)}</td><td class="plate-list">${plateHtml}</td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-cell">Nenhum veículo encontrado para os filtros selecionados.</td></tr>';
  }

  function collectStatusCounts() {
    const counts = new Map();
    state.days.forEach((day) => {
      if (Array.isArray(day.vehicles) && day.vehicles.length) {
        day.vehicles.forEach((v) => { const s = v.status || 'STATUS NÃO INFORMADO'; counts.set(s, (counts.get(s) || 0) + 1); });
      } else (day.statusCounts || []).forEach((s) => counts.set(s.status, (counts.get(s.status) || 0) + s.count));
    });
    return Array.from(counts, ([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count || a.status.localeCompare(b.status, 'pt-BR'));
  }

  function renderStatusConfig() {
    const rows = collectStatusCounts();
    $('#statusConfigBody').innerHTML = rows.length ? rows.map(({ status, count }) => {
      const classification = FleetCore.classifyStatus(status, state.statusConfig);
      const selectValue = classification.classification;
      const pending = classification.unknown;
      return `<tr><td>${escapeHtml(status)}</td><td class="num">${formatInt(count)}</td><td><select class="classification-select" data-status="${escapeHtml(status)}"><option value="available" ${selectValue === 'available' ? 'selected' : ''}>Disponível</option><option value="unavailable" ${selectValue === 'unavailable' ? 'selected' : ''}>Indisponível</option></select></td><td>${pending ? '<span class="pending-label">PENDENTE</span>' : '<span class="defined-label">CLASSIFICADO</span>'}</td></tr>`;
    }).join('') : '<tr><td colspan="4" class="empty-cell">Nenhum status identificado.</td></tr>';
  }

  function renderAll() {
    const entries = getEntries();
    renderCards(entries);
    renderAlert(entries);
    renderCharts(entries);
    renderHistory(entries);
    renderDetails(entries);
    renderStatusConfig();
  }

  async function importWorkbook(file) {
    if (!file) return;
    if (!window.XLSX || !window.FleetCore) {
      showToast('Não foi possível carregar o leitor Excel. Verifique sua conexão com a internet.');
      return;
    }
    $('#syncStatus').textContent = 'PROCESSANDO PLANILHA';
    showToast('Lendo abas diárias e recalculando os indicadores…');
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
      const imported = FleetCore.processWorkbook(workbook, { XLSX, statusConfig: state.statusConfig, includeVehicles: true, anchorDate: new Date(file.lastModified || Date.now()) });
      if (!imported.length) throw new Error('Nenhuma aba diária no padrão DD.MM foi encontrada.');
      const map = new Map(state.days.map((d) => [d.date, d]));
      imported.forEach((d) => map.set(d.date, d));
      state.days = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
      for (const day of imported) await putDay(day);
      await putMeta('lastImportAt', new Date().toISOString());
      state.selectedDetailDate = imported[imported.length - 1].date;
      $('#lastUpdated').textContent = formatDateTime(new Date().toISOString());
      $('#syncStatus').textContent = 'IMPORTAÇÃO CONCLUÍDA';
      populateFilters();
      renderAll();
      const duplicates = imported.reduce((sum, d) => sum + (d.duplicates || 0), 0);
      showToast(`${imported.length} abas diárias processadas. ${formatInt(duplicates)} linha(s) duplicada(s) ignorada(s).`);
    } catch (error) {
      console.error(error);
      $('#syncStatus').textContent = 'ERRO NA IMPORTAÇÃO';
      showToast(`Falha ao importar a planilha: ${error.message || 'erro desconhecido'}`);
    }
  }

  async function checkRemoteVersion(force) {
    if (location.protocol === 'file:') {
      if (force) showToast('No uso local, selecione “Importar planilha” para ler a versão atualizada do Excel.');
      return;
    }
    try {
      $('#syncStatus').textContent = 'VERIFICANDO GITHUB';
      const stamp = Date.now();
      const versionUrl = new URL(`data/version.json?nocache=${stamp}`, document.baseURI);
      const response = await fetch(versionUrl, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
      if (!response.ok) throw new Error(`version.json retornou HTTP ${response.status}`);
      const remote = await response.json();
      if (!remote.version) throw new Error('version.json sem identificador de versão');

      // Não exigir state.remoteVersion preenchida: esse era o motivo de a primeira
      // sincronização nunca acontecer quando o resumo inicial não carregava.
      if (remote.version !== state.remoteVersion) {
        $('#syncStatus').textContent = 'ATUALIZANDO DADOS';
        const summaryUrl = new URL(`data/initial-summary.json?nocache=${stamp}`, document.baseURI);
        const summaryResponse = await fetch(summaryUrl, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
        if (!summaryResponse.ok) throw new Error(`initial-summary.json retornou HTTP ${summaryResponse.status}`);
        const summary = await summaryResponse.json();
        if (summary.version !== remote.version || !Array.isArray(summary.days)) throw new Error('Versões dos dados publicados não conferem');
        window.FLEET_SUMMARY = summary;
        await mergeRemoteSummary(summary);
        $('#syncStatus').textContent = 'DADOS ATUALIZADOS';
        showToast(`Painel atualizado pelo GitHub. ${summary.days.length} dias no histórico.`);
      } else {
        $('#syncStatus').textContent = 'DADOS SINCRONIZADOS';
        if (force) showToast('O painel já está com a versão mais recente publicada.');
      }
    } catch (error) {
      console.warn('Falha na sincronização do painel:', error);
      $('#syncStatus').textContent = 'SINCRONIZAÇÃO PENDENTE';
      if (force) showToast(`Não foi possível atualizar pelo GitHub: ${error.message || 'verifique a publicação do Actions'}`);
    }
  }

  function exportHistory() {
    if (!window.XLSX) { showToast('Biblioteca Excel indisponível.'); return; }
    const entries = getEntries();
    const rows = entries.map(({ day, metrics }) => ({
      Data: formatDate(day.date), 'Frota total': metrics.fleetTotal, Manutenção: metrics.maintenance, Sinistro: metrics.sinistro || 0, 'Parados manutenção + sinistro': metrics.maintenanceSinistroTotal || (metrics.maintenance + (metrics.sinistro || 0)),
      'Disponibilidade física': metrics.physicalAvailable, '% Disponibilidade física': Number(metrics.physicalPercent.toFixed(2)),
      'Indisponíveis operação': metrics.unavailableOperation, 'Capacidade de utilização': metrics.operationalCapacity,
      '% Capacidade de utilização': Number(metrics.operationalPercent.toFixed(2)), 'Indisponíveis por outros motivos': metrics.unavailableOther
    }));
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 26 }, { wch: 22 }, { wch: 22 }, { wch: 23 }, { wch: 23 }, { wch: 23 }, { wch: 26 }];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Histórico gerencial');
    XLSX.writeFile(book, `historico_frota_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  function bindEvents() {
    ['#dateFrom', '#dateTo', '#dayFilter', '#baseFilter', '#rentalFilter'].forEach((id) => $(id).addEventListener('change', renderAll));
    $('#tableSearch').addEventListener('input', () => renderHistory(getEntries()));
    $('#clearFilters').addEventListener('click', () => {
      $('#dateFrom').value = ''; $('#dateTo').value = ''; $('#dayFilter').value = ''; $('#baseFilter').value = ''; $('#rentalFilter').value = ''; $('#tableSearch').value = '';
      renderAll();
    });
    $('#importButton').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', async (event) => {
      await importWorkbook(event.target.files?.[0]);
      event.target.value = '';
    });
    $('#refreshButton').addEventListener('click', () => checkRemoteVersion(true));
    $('#exportHistory').addEventListener('click', exportHistory);
    $('#historyBody').addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-date]');
      if (!row) return;
      state.selectedDetailDate = row.dataset.date;
      renderHistory(getEntries());
      renderDetails(getEntries());
      $('#detailSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#statusConfigBody').addEventListener('change', (event) => {
      const select = event.target.closest('select[data-status]');
      if (!select) return;
      const status = select.dataset.status;
      state.statusConfig[FleetCore.normalize(status)] = select.value;
      persistStatusConfig();
      renderAll();
      $('#settingsSaveNote').textContent = `Classificação de “${status}” salva neste navegador.`;
    });
    $('#resetStatusConfig').addEventListener('click', () => {
      state.statusConfig = {};
      persistStatusConfig();
      renderAll();
      $('#settingsSaveNote').textContent = 'Classificações padrão restauradas.';
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    state.db = await openDatabase();
    await initializeData();
    if (!window.Chart) {
      document.querySelectorAll('.chart-wrap').forEach((node) => { node.innerHTML = '<div class="empty-cell">Gráficos indisponíveis. Verifique a conexão com a internet.</div>'; });
    }
    if (location.protocol !== 'file:') {
      // Verifica assim que a página abre, ao voltar para a aba e periodicamente.
      await checkRemoteVersion(false);
      setInterval(() => checkRemoteVersion(false), POLL_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkRemoteVersion(false);
      });
      window.addEventListener('focus', () => checkRemoteVersion(false));
    }
  });
})();
