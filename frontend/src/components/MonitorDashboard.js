import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './MonitorDashboard.css';

const API_URL = process.env.REACT_APP_API_URL || '';
const SNAPSHOT_INTERVAL_MS = 30000;
const HISTORY_INTERVAL_MS = 60000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RANGE_OPTIONS = [
  { id: '1h', label: '1 soat', ms: HOUR_MS },
  { id: '6h', label: '6 soat', ms: 6 * HOUR_MS },
  { id: '24h', label: '24 soat', ms: DAY_MS },
  { id: '72h', label: '3 kun', ms: 3 * DAY_MS }
];

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token') || ''}` };
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value.toFixed(value < 10 ? 1 : 0)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(1)} ${units[unit]}`;
}

function formatRate(value) {
  return Number.isFinite(value) ? `${formatBytes(value)}/s` : 'Yig‘ilmoqda';
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

function dateTimeInputValue(value) {
  const adjusted = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 16);
}

function axisTime(timestamp, rangeMs) {
  const date = new Date(timestamp);
  if (rangeMs > DAY_MS) {
    return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  }
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function chartSamples(samples, limit = 700) {
  if (samples.length <= limit) return samples;
  const step = Math.ceil((samples.length - 1) / (limit - 1));
  const result = samples.filter((_, index) => index % step === 0);
  if (result[result.length - 1] !== samples[samples.length - 1]) result.push(samples[samples.length - 1]);
  return result;
}

function MetricChart({ samples, series, rangeMs, formatValue, maxValue, label }) {
  const plottedSamples = chartSamples(samples);
  if (plottedSamples.length < 2) {
    return <div className="monitor-chart-empty">Tarix yig‘ilmoqda. Grafik uchun kamida 2 ta o‘lchov kerak.</div>;
  }

  const width = 760;
  const height = 212;
  const left = 62;
  const right = 12;
  const top = 12;
  const bottom = 32;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const start = Date.parse(plottedSamples[0].timestamp);
  const end = Date.parse(plottedSamples[plottedSamples.length - 1].timestamp);
  const span = Math.max(1, end - start);
  const allValues = plottedSamples.flatMap(sample => series
    .map(item => item.value(sample))
    .filter(Number.isFinite));
  const ceiling = maxValue || Math.max(1, ...allValues) * 1.12;
  const yFor = value => top + plotHeight - (Math.max(0, value) / ceiling) * plotHeight;
  const xFor = sample => left + ((Date.parse(sample.timestamp) - start) / span) * plotWidth;

  const paths = series.flatMap(item => {
    const segments = [];
    let segment = [];
    plottedSamples.forEach(sample => {
      const value = item.value(sample);
      if (Number.isFinite(value)) {
        segment.push(`${segment.length ? 'L' : 'M'} ${xFor(sample).toFixed(1)} ${yFor(value).toFixed(1)}`);
      } else if (segment.length) {
        segments.push(segment.join(' '));
        segment = [];
      }
    });
    if (segment.length) segments.push(segment.join(' '));
    return segments.map((d, index) => <path key={`${item.key}-${index}`} d={d} fill="none" stroke={item.color} strokeWidth="2.4" vectorEffect="non-scaling-stroke" />);
  });

  const xTicks = Array.from({ length: 5 }, (_, index) => {
    const timestamp = new Date(start + (span * index) / 4).toISOString();
    return { timestamp, position: index / 4 };
  });

  return (
    <div className="monitor-chart-wrap">
      <svg className="monitor-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        {[0, 0.25, 0.5, 0.75, 1].map(fraction => {
          const y = top + plotHeight - fraction * plotHeight;
          return (
            <g key={fraction}>
              <line x1={left} x2={width - right} y1={y} y2={y} className="monitor-chart-grid" />
              <text x={left - 9} y={y + 4} textAnchor="end" className="monitor-chart-axis-label">{formatValue(ceiling * fraction)}</text>
            </g>
          );
        })}
        {xTicks.map((tick, index) => {
          const x = left + tick.position * plotWidth;
          return <text key={`${tick.timestamp}-${index}`} x={x} y={height - 7} textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'} className="monitor-chart-axis-label">{axisTime(tick.timestamp, rangeMs)}</text>;
        })}
        {paths}
      </svg>
      {series.length > 1 && (
        <div className="monitor-chart-legend">
          {series.map(item => <span key={item.key}><i style={{ backgroundColor: item.color }} />{item.label}</span>)}
        </div>
      )}
    </div>
  );
}

function MetricCard({ title, value, detail, samples, series, rangeMs, formatValue, maxValue, tone }) {
  return (
    <article className={`monitor-metric-card ${tone || ''}`}>
      <div className="monitor-metric-heading">
        <span>{title}</span>
        <strong>{value}</strong>
      </div>
      <p className="monitor-metric-detail">{detail}</p>
      <MetricChart
        samples={samples}
        series={series}
        rangeMs={rangeMs}
        formatValue={formatValue}
        maxValue={maxValue}
        label={`${title} vaqt bo‘yicha grafigi`}
      />
    </article>
  );
}

function ContainerRow({ container, selected, onSelect }) {
  const running = container.state === 'running';
  return (
    <tr className={selected ? 'is-selected' : ''} onClick={onSelect}>
      <td>
        <button className="monitor-container-select" type="button" onClick={onSelect}>
          <span className={`monitor-container-dot ${running ? 'running' : ''}`} />
          <span>
            <strong>{container.name}</strong>
            <small>{container.id}</small>
          </span>
        </button>
      </td>
      <td><span className={`monitor-state ${running ? 'running' : 'stopped'}`}>{running ? 'Ishlayapti' : 'To‘xtagan'}</span></td>
      <td>{running ? formatPercent(Number(container.cpuPercent)) : '—'}</td>
      <td>
        {running ? (
          <div className="monitor-table-memory">
            <span>{formatPercent(Number(container.memPercent))}</span>
            <small>{formatBytes(Number(container.memUsage))} / {formatBytes(Number(container.memLimit))}</small>
          </div>
        ) : '—'}
      </td>
      <td>{formatBytes(Number(container.networkRxBytes))}</td>
      <td>{formatBytes(Number(container.networkTxBytes))}</td>
    </tr>
  );
}

export default function MonitorDashboard({ onBack, onSessionExpired, containers = [] }) {
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState([]);
  const [rangeKey, setRangeKey] = useState('6h');
  const [customFrom, setCustomFrom] = useState(() => dateTimeInputValue(new Date(Date.now() - 6 * HOUR_MS)));
  const [customTo, setCustomTo] = useState(() => dateTimeInputValue(new Date()));
  const [customRange, setCustomRange] = useState(null);
  const [error, setError] = useState('');
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [selectedContainerId, setSelectedContainerId] = useState('');
  const snapshotBusy = useRef(false);
  const historyBusy = useRef(false);
  const onSessionExpiredRef = useRef(onSessionExpired);

  useEffect(() => { onSessionExpiredRef.current = onSessionExpired; }, [onSessionExpired]);

  const refreshSnapshot = useCallback(async () => {
    if (snapshotBusy.current) return;
    snapshotBusy.current = true;
    try {
      const response = await fetch(`${API_URL}/api/monitor/snapshot`, { headers: authHeaders() });
      if (response.status === 401) {
        onSessionExpiredRef.current();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Monitor so‘rovi bajarilmadi (${response.status})`);
      setSnapshot(body);
      setUpdatedAt(new Date());
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Joriy ko‘rsatkichlarni olib bo‘lmadi');
    } finally {
      snapshotBusy.current = false;
      setSnapshotLoading(false);
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    if (historyBusy.current) return;
    let from;
    let to;
    if (rangeKey === 'custom') {
      if (!customRange) return;
      ({ from, to } = customRange);
    } else {
      const range = RANGE_OPTIONS.find(option => option.id === rangeKey) || RANGE_OPTIONS[1];
      to = Date.now();
      from = to - range.ms;
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      setError('Boshlanish va tugash vaqtini tekshiring');
      setHistoryLoading(false);
      return;
    }
    if (to - from > 3 * DAY_MS) {
      setError('Tanlangan vaqt oralig‘i 3 kundan oshmasligi kerak');
      setHistoryLoading(false);
      return;
    }

    historyBusy.current = true;
    try {
      const query = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
      const response = await fetch(`${API_URL}/api/monitor/history?${query}`, { headers: authHeaders() });
      if (response.status === 401) {
        onSessionExpiredRef.current();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Tarixni olib bo‘lmadi (${response.status})`);
      setHistory(body.samples || []);
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Tarixiy ko‘rsatkichlarni olib bo‘lmadi');
    } finally {
      historyBusy.current = false;
      setHistoryLoading(false);
    }
  }, [rangeKey, customRange]);

  const refreshAll = useCallback(() => {
    refreshSnapshot();
    refreshHistory();
  }, [refreshSnapshot, refreshHistory]);

  useEffect(() => {
    refreshSnapshot();
    const timer = setInterval(refreshSnapshot, SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshSnapshot]);

  useEffect(() => {
    setHistoryLoading(true);
    refreshHistory();
    const timer = setInterval(refreshHistory, HISTORY_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshHistory]);

  const rangeMs = rangeKey === 'custom'
    ? Math.max(1, (customRange?.to || Date.now()) - (customRange?.from || Date.now() - HOUR_MS))
    : (RANGE_OPTIONS.find(option => option.id === rangeKey)?.ms || 6 * HOUR_MS);
  const host = snapshot?.host;
  const sortedContainers = useMemo(() => [...containers].sort((a, b) => {
    if ((a.state === 'running') !== (b.state === 'running')) return a.state === 'running' ? -1 : 1;
    return Number(b.cpuPercent || 0) - Number(a.cpuPercent || 0);
  }), [containers]);
  const containerOptions = useMemo(() => {
    const options = new Map();
    sortedContainers.forEach(item => {
      const id = item.fullId || item.id;
      options.set(id, { id, name: item.name, state: item.state });
    });
    history.forEach(sample => (sample.containers || []).forEach(item => {
      if (!options.has(item.id)) options.set(item.id, { id: item.id, name: item.name, state: item.state });
    }));
    return [...options.values()];
  }, [sortedContainers, history]);
  const activeContainerId = selectedContainerId
    || sortedContainers.find(item => item.state === 'running')?.fullId
    || sortedContainers[0]?.fullId
    || containerOptions[0]?.id
    || '';
  const activeContainer = sortedContainers.find(item => item.fullId === activeContainerId || item.id === activeContainerId);
  const activeContainerSamples = useMemo(() => history.map(sample => ({
    timestamp: sample.timestamp,
    container: activeContainerId
      ? sample.containers?.find(item => item.id === activeContainerId || item.id?.startsWith(activeContainerId)) || null
      : null
  })), [history, activeContainerId]);
  const serverCpuSeries = [{ key: 'cpu', label: 'CPU', color: '#3478f6', value: sample => sample.host?.cpu?.percent }];
  const serverMemorySeries = [{ key: 'memory', label: 'RAM', color: '#8758dc', value: sample => sample.host?.memory?.percent }];
  const serverDiskSeries = [{ key: 'disk', label: 'Disk', color: '#14a06f', value: sample => sample.host?.disk?.percent }];
  const serverNetworkSeries = [
    { key: 'rx', label: 'Qabul', color: '#3478f6', value: sample => sample.host?.network?.rxBytesPerSecond },
    { key: 'tx', label: 'Yuborish', color: '#e58a28', value: sample => sample.host?.network?.txBytesPerSecond }
  ];
  const containerCpuSeries = [{ key: 'cpu', label: 'CPU', color: '#3478f6', value: sample => sample.container?.cpuPercent }];
  const containerMemorySeries = [{ key: 'memory', label: 'RAM', color: '#8758dc', value: sample => sample.container?.memory?.percent }];
  const containerNetworkSeries = [
    { key: 'rx', label: 'Qabul', color: '#3478f6', value: sample => sample.container?.network?.rxBytesPerSecond },
    { key: 'tx', label: 'Yuborish', color: '#e58a28', value: sample => sample.container?.network?.txBytesPerSecond }
  ];
  const latestContainerSample = activeContainerSamples.slice().reverse().find(item => item.container)?.container;
  const networkScope = host?.network?.source === 'server' ? 'Server interfeyslari' : 'Ilova tarmog‘i';
  const hostNetworkValue = host?.network
    ? <span className="monitor-network-value"><span>↓ {formatRate(host.network.rxBytesPerSecond)}</span><span>↑ {formatRate(host.network.txBytesPerSecond)}</span></span>
    : 'Mavjud emas';

  function applyCustomRange() {
    const from = new Date(customFrom).getTime();
    const to = new Date(customTo).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 3 * DAY_MS) {
      setError('Vaqt oralig‘ini to‘g‘ri tanlang (maksimum 3 kun)');
      return;
    }
    setCustomRange({ from, to });
    setRangeKey('custom');
  }

  return (
    <main className="monitor-page">
      <header className="monitor-page-header">
        <div className="monitor-heading-copy">
          <div className="monitor-brand-row">
            <span className="monitor-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 48 48" role="presentation">
                <path className="monitor-brand-cube" d="M24 5 41 14.5v19L24 43 7 33.5v-19L24 5Z" />
                <path className="monitor-brand-grid" d="M7.5 14.8 24 24l16.5-9.2M24 24v18M15 10l17 9.5v7" />
                <path className="monitor-brand-pulse" d="m17 30 4.3-4.3 4.1 4.1 6.6-7" />
                <circle className="monitor-brand-spark" cx="32" cy="22.8" r="2" />
              </svg>
            </span>
            <span className="monitor-brand-name">
              <strong>DOCKER LOG VIEWER</strong>
              <small>SERVER MONITOR</small>
            </span>
            <span className="monitor-brand-divider" aria-hidden="true" />
            <span className="monitor-brand-status"><i className="monitor-live-dot" /> Kuzatuv faol</span>
          </div>
          <h1>Resurslar holati</h1>
          <p>{host?.hostname || 'Server va Docker containerlari'} · ko‘rsatkichlar vaqt bo‘yicha saqlanadi</p>
        </div>
        <div className="monitor-header-actions">
          <div className="monitor-updated"><span>Oxirgi yangilanish</span><strong>{updatedAt ? updatedAt.toLocaleTimeString() : 'Ulanmoqda…'}</strong></div>
          <button className="monitor-button monitor-refresh-btn" onClick={refreshAll} disabled={snapshotLoading || historyLoading}>Yangilash</button>
          <button className="monitor-button monitor-back-btn" onClick={onBack}>Loglarga qaytish</button>
        </div>
      </header>

      {error && <div className="monitor-error" role="alert">{error}</div>}

      <section className="monitor-range-panel" aria-label="Tarix oralig‘ini tanlash">
        <div className="monitor-range-copy">
          <strong>Vaqt oralig‘i</strong>
          <span>Tarix ko‘pi bilan 3 kun saqlanadi · har daqiqada o‘lchov</span>
        </div>
        <div className="monitor-range-controls">
          <div className="monitor-range-presets">
            {RANGE_OPTIONS.map(option => (
              <button key={option.id} className={`monitor-range-button ${rangeKey === option.id ? 'active' : ''}`} onClick={() => setRangeKey(option.id)}>
                {option.label}
              </button>
            ))}
          </div>
          <div className="monitor-custom-range">
            <label>dan <input type="datetime-local" value={customFrom} onChange={event => setCustomFrom(event.target.value)} /></label>
            <label>gacha <input type="datetime-local" value={customTo} onChange={event => setCustomTo(event.target.value)} /></label>
            <button className={`monitor-range-button apply ${rangeKey === 'custom' ? 'active' : ''}`} onClick={applyCustomRange}>Tanlash</button>
          </div>
        </div>
      </section>

      <section className="monitor-section">
        <div className="monitor-section-heading">
          <div><h2>Server resurslari</h2><p>Joriy qiymatlar va tanlangan davr grafigi</p></div>
          <span className="monitor-sample-count">{history.length.toLocaleString()} o‘lchov</span>
        </div>
        <div className="monitor-metric-grid">
          <MetricCard
            title="CPU bandligi"
            value={formatPercent(host?.cpu?.percent)}
            detail={`${host?.cpu?.cores ?? '—'} yadro · load ${host?.cpu?.loadAvg?.[0]?.toFixed?.(2) ?? '—'}`}
            samples={history}
            series={serverCpuSeries}
            rangeMs={rangeMs}
            formatValue={formatPercent}
            maxValue={100}
            tone="cpu"
          />
          <MetricCard
            title="Xotira (RAM)"
            value={formatPercent(host?.memory?.percent)}
            detail={`${formatBytes(host?.memory?.used)} / ${formatBytes(host?.memory?.total)} ishlatilgan`}
            samples={history}
            series={serverMemorySeries}
            rangeMs={rangeMs}
            formatValue={formatPercent}
            maxValue={100}
            tone="memory"
          />
          <MetricCard
            title="Disk bandligi"
            value={formatPercent(host?.disk?.percent)}
            detail={`${formatBytes(host?.disk?.used)} / ${formatBytes(host?.disk?.total)} · ${formatBytes(host?.disk?.available)} bo‘sh`}
            samples={history}
            series={serverDiskSeries}
            rangeMs={rangeMs}
            formatValue={formatPercent}
            maxValue={100}
            tone="disk"
          />
          <MetricCard
            title="Tarmoq tezligi"
            value={hostNetworkValue}
            detail={networkScope}
            samples={history}
            series={serverNetworkSeries}
            rangeMs={rangeMs}
            formatValue={formatRate}
            tone="network"
          />
        </div>
        {history.length === 0 && !historyLoading && <p className="monitor-history-empty">Hozircha tanlangan davr uchun saqlangan o‘lchov yo‘q. Yangi tarix keyingi daqiqalik o‘lchovlardan yig‘iladi.</p>}
      </section>

      <section className="monitor-section">
        <div className="monitor-section-heading monitor-container-heading">
          <div><h2>Containerlar</h2><p>Joriy CPU, RAM va ishga tushgandan beri tarmoq trafigi</p></div>
          <span className="monitor-sample-count">{sortedContainers.filter(item => item.state === 'running').length} / {sortedContainers.length} ishlayapti</span>
        </div>
        <div className="monitor-table-wrap">
          <table className="monitor-table">
            <thead><tr><th>Container</th><th>Holat</th><th>CPU</th><th>RAM</th><th>Qabul qildi</th><th>Yubordi</th></tr></thead>
            <tbody>
              {sortedContainers.map(container => {
                const id = container.fullId || container.id;
                return <ContainerRow key={id} container={container} selected={id === activeContainerId} onSelect={() => setSelectedContainerId(id)} />;
              })}
              {!sortedContainers.length && !snapshotLoading && <tr><td colSpan="6" className="monitor-empty">Container topilmadi</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="monitor-section monitor-container-history">
        <div className="monitor-section-heading">
          <div><h2>Container tarixi</h2><p>{activeContainer?.name || latestContainerSample?.name || 'Tanlangan container'} · tanlangan vaqt bo‘yicha CPU, RAM va network</p></div>
          {containerOptions.length > 0 && (
            <label className="monitor-container-picker">Container
              <select value={activeContainerId} onChange={event => setSelectedContainerId(event.target.value)}>
                {containerOptions.map(container => <option key={container.id} value={container.id}>{container.name}{container.state === 'removed' ? ' (o‘chirilgan)' : ''}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="monitor-metric-grid container-metric-grid">
          <MetricCard
            title="Container CPU"
            value={activeContainer ? formatPercent(Number(activeContainer.cpuPercent)) : formatPercent(latestContainerSample?.cpuPercent)}
            detail={activeContainer?.name || latestContainerSample?.name || 'Container tanlanmagan'}
            samples={activeContainerSamples}
            series={containerCpuSeries}
            rangeMs={rangeMs}
            formatValue={formatPercent}
            maxValue={100}
            tone="cpu"
          />
          <MetricCard
            title="Container RAM"
            value={activeContainer ? formatPercent(Number(activeContainer.memPercent)) : formatPercent(latestContainerSample?.memory?.percent)}
            detail={activeContainer
              ? `${formatBytes(Number(activeContainer.memUsage))} / ${formatBytes(Number(activeContainer.memLimit))}`
              : latestContainerSample?.memory ? `${formatBytes(latestContainerSample.memory.used)} / ${formatBytes(latestContainerSample.memory.limit)} · so‘nggi o‘lchov` : '—'}
            samples={activeContainerSamples}
            series={containerMemorySeries}
            rangeMs={rangeMs}
            formatValue={formatPercent}
            maxValue={100}
            tone="memory"
          />
          <MetricCard
            title="Container tarmog‘i"
            value={latestContainerSample?.network
              ? <span className="monitor-network-value"><span>↓ {formatRate(latestContainerSample.network.rxBytesPerSecond)}</span><span>↑ {formatRate(latestContainerSample.network.txBytesPerSecond)}</span></span>
              : 'Yig‘ilmoqda'}
            detail={activeContainer?.name || latestContainerSample?.name || '—'}
            samples={activeContainerSamples}
            series={containerNetworkSeries}
            rangeMs={rangeMs}
            formatValue={formatRate}
            tone="network"
          />
        </div>
        {activeContainer && activeContainerSamples.every(item => !item.container) && !historyLoading && (
          <p className="monitor-history-empty">Bu container uchun tanlangan davrda saqlangan tarix yo‘q. Yangi o‘lchovlar keyingi daqiqada paydo bo‘ladi.</p>
        )}
      </section>
    </main>
  );
}
