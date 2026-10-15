import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@fontsource-variable/inter';
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

// Keeps at most `limit` points for drawing. With `peakValue`, each bucket
// keeps its highest sample, so short spikes survive the downsampling.
function chartSamples(samples, limit = 700, peakValue = null) {
  if (samples.length <= limit) return samples;
  const bucketSize = samples.length / limit;
  const result = [];
  for (let bucket = 0; bucket < limit; bucket += 1) {
    const from = Math.floor(bucket * bucketSize);
    const to = Math.min(samples.length, Math.floor((bucket + 1) * bucketSize));
    let chosen = samples[from];
    if (peakValue) {
      let best = -Infinity;
      for (let index = from; index < to; index += 1) {
        const value = peakValue(samples[index]);
        if (Number.isFinite(value) && value > best) {
          best = value;
          chosen = samples[index];
        }
      }
    }
    if (chosen && result[result.length - 1] !== chosen) result.push(chosen);
  }
  const last = samples[samples.length - 1];
  if (result[result.length - 1] !== last) result.push(last);
  return result;
}

// Average and peak of one series over the selected range
function seriesStats(samples, value) {
  let total = 0;
  let count = 0;
  let max = -Infinity;
  let maxAt = null;
  for (const sample of samples) {
    const current = Number(value(sample));
    if (!Number.isFinite(current)) continue;
    total += current;
    count += 1;
    if (current > max) {
      max = current;
      maxAt = sample.timestamp;
    }
  }
  return count ? { avg: total / count, max, maxAt } : null;
}

function levelColor(percent) {
  if (!Number.isFinite(percent)) return '#7f8ea3';
  if (percent >= 90) return '#ff6b75';
  if (percent >= 75) return '#f5b14c';
  return '#3fd06a';
}

function tooltipTime(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

// Width of an element, kept up to date while the layout changes
function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => setWidth(Math.round(element.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function gaugeArc(startAngle, endAngle, radius = 70) {
  const centerX = 120;
  const centerY = 89;
  const point = angle => {
    const radians = (angle * Math.PI) / 180;
    return `${(centerX + radius * Math.cos(radians)).toFixed(2)} ${(centerY + radius * Math.sin(radians)).toFixed(2)}`;
  };
  const sweep = endAngle - startAngle;
  return `M ${point(startAngle)} A ${radius} ${radius} 0 ${sweep > 180 ? 1 : 0} 1 ${point(endAngle)}`;
}

function ResourceGauge({ percent, value, caption }) {
  const known = Number.isFinite(percent);
  const safePercent = known ? Math.max(0, Math.min(100, percent)) : 0;
  // The number takes the same status colour as the arc: green, amber, red
  const color = levelColor(known ? safePercent : NaN);
  const startAngle = 135;
  const endAngle = startAngle + (safePercent / 100) * 270;
  return (
    <svg className="monitor-resource-gauge" viewBox="0 0 240 154" role="img" aria-label={`${caption}: ${value}`}>
      <path d={gaugeArc(startAngle, startAngle + 270)} className="monitor-gauge-track" />
      <path d={gaugeArc(startAngle, startAngle + 189)} className="monitor-gauge-threshold low" />
      <path d={gaugeArc(startAngle + 189, startAngle + 243)} className="monitor-gauge-threshold medium" />
      <path d={gaugeArc(startAngle + 243, startAngle + 270)} className="monitor-gauge-threshold high" />
      {safePercent > 0 && <path d={gaugeArc(startAngle, endAngle)} className="monitor-gauge-value-arc" style={{ stroke: color }} />}
      <text x="120" y="96" textAnchor="middle" className="monitor-gauge-value" style={{ fill: color }}>{value}</text>
      <text x="120" y="119" textAnchor="middle" className="monitor-gauge-caption">{caption}</text>
      <text x="40" y="148" textAnchor="middle" className="monitor-gauge-scale">0%</text>
      <text x="200" y="148" textAnchor="middle" className="monitor-gauge-scale">100%</text>
    </svg>
  );
}

const AXIS_CHAR_WIDTH = 7.4; // ~12px Inter digits

// Line chart drawn at its real pixel size, so axis text stays readable in
// small cards. Hovering shows the exact time and values.
function MetricChart({ samples, series, rangeMs, formatValue, maxValue, label, height = 210 }) {
  const [wrapRef, measuredWidth] = useElementWidth();
  const [hoverIndex, setHoverIndex] = useState(null);
  const width = Math.max(160, measuredWidth || 600);
  const plottedSamples = useMemo(
    () => chartSamples(samples, Math.max(60, Math.round(width / 1.5)), series[0]?.value),
    // series objects are recreated on every render, so they are not a
    // dependency; the first series only picks which sample a bucket keeps
    [samples, width]
  );

  if (plottedSamples.length < 2) {
    return (
      <div className="monitor-chart-wrap" ref={wrapRef}>
        <div className="monitor-chart-empty" style={{ minHeight: height }}>Tarix yig‘ilmoqda. Grafik uchun kamida 2 ta o‘lchov kerak.</div>
      </div>
    );
  }

  const allValues = plottedSamples.flatMap(sample => series
    .map(item => item.value(sample))
    .filter(Number.isFinite));
  const ceiling = maxValue || Math.max(1, ...allValues) * 1.12;
  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const yLabels = yTicks.map(fraction => formatValue(ceiling * fraction));
  const left = Math.ceil(Math.max(...yLabels.map(text => text.length)) * AXIS_CHAR_WIDTH) + 14;
  const right = 14;
  const top = 10;
  const bottom = 28;
  const plotWidth = Math.max(40, width - left - right);
  const plotHeight = height - top - bottom;
  const start = Date.parse(plottedSamples[0].timestamp);
  const end = Date.parse(plottedSamples[plottedSamples.length - 1].timestamp);
  const span = Math.max(1, end - start);
  const yFor = value => top + plotHeight - (Math.min(Math.max(0, value), ceiling) / ceiling) * plotHeight;
  const xForTime = time => left + ((time - start) / span) * plotWidth;
  const xFor = sample => xForTime(Date.parse(sample.timestamp));

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
    return segments.map((d, index) => <path key={`${item.key}-${index}`} d={d} fill="none" stroke={item.color} strokeWidth="2" strokeLinejoin="round" />);
  });

  // As many time labels as fit without overlapping
  const xTickCount = Math.max(2, Math.min(6, Math.floor(plotWidth / 92) + 1));
  const xTicks = Array.from({ length: xTickCount }, (_, index) => ({
    time: start + (span * index) / (xTickCount - 1),
    position: index / (xTickCount - 1)
  }));

  function handlePointerMove(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const time = start + ((x - left) / plotWidth) * span;
    let low = 0;
    let high = plottedSamples.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (Date.parse(plottedSamples[middle].timestamp) < time) low = middle;
      else high = middle;
    }
    const nearest = Math.abs(Date.parse(plottedSamples[low].timestamp) - time) <= Math.abs(Date.parse(plottedSamples[high].timestamp) - time) ? low : high;
    setHoverIndex(nearest);
  }

  const hovered = hoverIndex !== null ? plottedSamples[hoverIndex] : null;
  const hoverX = hovered ? xFor(hovered) : 0;

  return (
    <div className="monitor-chart-wrap" ref={wrapRef}>
      <svg
        className="monitor-chart"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        {yTicks.map((fraction, index) => {
          const y = top + plotHeight - fraction * plotHeight;
          return (
            <g key={fraction}>
              <line x1={left} x2={width - right} y1={y} y2={y} className="monitor-chart-grid" />
              <text x={left - 8} y={y + 4} textAnchor="end" className="monitor-chart-axis-label">{yLabels[index]}</text>
            </g>
          );
        })}
        {xTicks.map((tick, index) => (
          <text
            key={index}
            x={left + tick.position * plotWidth}
            y={height - 7}
            textAnchor={index === 0 ? 'start' : index === xTickCount - 1 ? 'end' : 'middle'}
            className="monitor-chart-axis-label"
          >
            {axisTime(tick.time, rangeMs)}
          </text>
        ))}
        {paths}
        {hovered && (
          <g className="monitor-chart-hover">
            <line x1={hoverX} x2={hoverX} y1={top} y2={top + plotHeight} />
            {series.map(item => {
              const value = item.value(hovered);
              return Number.isFinite(value)
                ? <circle key={item.key} cx={hoverX} cy={yFor(value)} r="4" style={{ fill: item.color }} />
                : null;
            })}
          </g>
        )}
      </svg>
      {hovered && (
        <div
          className={`monitor-chart-tooltip ${hoverX > width / 2 ? 'left' : 'right'}`}
          style={{ left: hoverX, top }}
        >
          <time>{tooltipTime(hovered.timestamp)}</time>
          {series.map(item => (
            <span key={item.key}>
              <i style={{ backgroundColor: item.color }} />{item.label}
              <strong>{Number.isFinite(item.value(hovered)) ? formatValue(item.value(hovered)) : '—'}</strong>
            </span>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div className="monitor-chart-legend">
          {series.map(item => <span key={item.key}><i style={{ backgroundColor: item.color }} />{item.label}</span>)}
        </div>
      )}
    </div>
  );
}

// "o‘rtacha 32.1% · eng yuqori 87.4% (14:05)" for the selected range
function RangeStats({ samples, series, formatValue }) {
  const parts = series.map(item => {
    const stats = seriesStats(samples, item.value);
    if (!stats) return null;
    const prefix = series.length > 1 ? `${item.label}: ` : '';
    return (
      <span key={item.key} title={stats.maxAt ? `Eng yuqori qiymat vaqti: ${new Date(stats.maxAt).toLocaleString()}` : undefined}>
        {prefix}o‘rtacha <b>{formatValue(stats.avg)}</b> · eng yuqori <b>{formatValue(stats.max)}</b>
      </span>
    );
  }).filter(Boolean);
  if (!parts.length) return null;
  return <div className="monitor-range-stats">{parts}</div>;
}

function MetricCard({ title, value, detail, samples, series, rangeMs, formatValue, maxValue, tone }) {
  return (
    <article className={`monitor-metric-card ${tone || ''}`}>
      <div className="monitor-metric-heading">
        <span>{title}</span>
        <strong>{value}</strong>
      </div>
      <p className="monitor-metric-detail">{detail}</p>
      <RangeStats samples={samples} series={series} formatValue={formatValue} />
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

function GaugeMetricCard({ title, detail, percent, value, caption, samples, series, rangeMs, formatValue, maxValue, tone }) {
  return (
    <article className={`monitor-metric-card monitor-gauge-card ${tone || ''}`}>
      <div className="monitor-gauge-heading"><strong>{title}</strong><span title={detail}>{detail}</span></div>
      <ResourceGauge percent={percent} value={value} caption={caption} />
      <RangeStats samples={samples} series={series} formatValue={formatValue} />
      <MetricChart
        samples={samples}
        series={series}
        rangeMs={rangeMs}
        formatValue={formatValue}
        maxValue={maxValue}
        height={150}
        label={`${title} vaqt bo‘yicha grafigi`}
      />
    </article>
  );
}

function SpeedTestCard({ tests, rangeMs, running, latest, onRun }) {
  const speedSeries = [
    { key: 'download', label: 'Yuklab olish', color: '#5aa3ff', value: sample => sample.downloadMbps },
    { key: 'upload', label: 'Yuborish', color: '#ae82ff', value: sample => sample.uploadMbps }
  ];
  const formatMbps = value => Number.isFinite(value) ? `${value.toFixed(value < 10 ? 2 : 1)} Mbps` : '—';
  return (
    <article className="monitor-metric-card monitor-speed-test-card network">
      <div className="monitor-speed-test-heading">
        <div>
          <h3>Server internet tezligi</h3>
          <p>Cloudflare edge serverigacha · test qo‘lda ishga tushadi</p>
        </div>
        <button className="monitor-button monitor-speed-test-button" onClick={onRun} disabled={running}>
          {running ? 'O‘lchanmoqda…' : 'Tezlikni o‘lchash'}
        </button>
      </div>
      <div className="monitor-speed-test-results">
        <div className="monitor-speed-result download"><span>↓ Yuklab olish</span><strong>{formatMbps(latest?.downloadMbps)}</strong></div>
        <div className="monitor-speed-result upload"><span>↑ Yuborish</span><strong>{formatMbps(latest?.uploadMbps)}</strong></div>
        <div className="monitor-speed-result latency"><span>Ping</span><strong>{Number.isFinite(latest?.latencyMs) ? `${latest.latencyMs.toFixed(0)} ms` : '—'}</strong></div>
      </div>
      <p className="monitor-speed-test-meta">Har test taxminan 39 MB trafik ishlatadi{latest?.timestamp ? ` · oxirgi test ${new Date(latest.timestamp).toLocaleString()}` : ''}</p>
      <MetricChart
        samples={tests}
        series={speedSeries}
        rangeMs={rangeMs}
        formatValue={formatMbps}
        label="Server internet tezligining tarixiy grafigi"
      />
    </article>
  );
}

function containerIdMatches(sampleId, containerId) {
  return sampleId === containerId
    || (typeof sampleId === 'string' && typeof containerId === 'string'
      && (sampleId.startsWith(containerId) || containerId.startsWith(sampleId)));
}

function ContainerHistoryBars({ container, history }) {
  const id = container.fullId || container.id;
  const entries = history.flatMap(sample => {
    const metrics = sample.containers?.find(item => containerIdMatches(item.id, id));
    return metrics ? [{ timestamp: sample.timestamp, metrics }] : [];
  });
  const plotted = chartSamples(entries, 24, sample => Number(sample.metrics.cpuPercent));
  const cpuValues = plotted.map(sample => sample.metrics.cpuPercent != null && Number.isFinite(Number(sample.metrics.cpuPercent)) ? Number(sample.metrics.cpuPercent) : null);
  const memoryValues = plotted.map(sample => sample.metrics.memory?.percent != null && Number.isFinite(Number(sample.metrics.memory.percent)) ? Number(sample.metrics.memory.percent) : null);
  // Absolute scales: a bar's height is the real share, not a share of this
  // container's own peak (which drew 0.1% RAM as a full bar). CPU can pass
  // 100% on several cores, so its scale grows when it does.
  const cpuPeak = Math.max(100, ...cpuValues.filter(Number.isFinite));
  const memoryPeak = 100;

  function renderBars(values, peak, seriesName, colorClass) {
    if (!plotted.length) return <div className="monitor-vertical-bars empty" aria-label={`${seriesName} tarixi yig‘ilmoqda`} />;
    return (
      <div className="monitor-vertical-bars" role="img" aria-label={`${container.name} ${seriesName} tarixi`}>
        {plotted.map((sample, index) => {
          const value = values[index];
          const height = value === null ? 3 : Math.max(4, (value / peak) * 100);
          const label = value === null ? 'o‘lchov yo‘q' : `${value.toFixed(1)}%`;
          return <i key={`${sample.timestamp}-${index}`} className={colorClass} style={{ height: `${height}%` }} title={`${new Date(sample.timestamp).toLocaleString()} · ${seriesName}: ${label}`} />;
        })}
      </div>
    );
  }

  const latest = plotted[plotted.length - 1]?.metrics;
  const latestCpu = latest?.cpuPercent == null ? null : Number(latest.cpuPercent);
  const latestMemory = latest?.memory?.percent == null ? null : Number(latest.memory.percent);

  return (
    <div className="monitor-container-history-bars">
      <div className="monitor-mini-series">
        <div className="monitor-mini-series-label"><span><i className="cpu" />CPU</span><strong>{Number.isFinite(latestCpu) ? formatPercent(latestCpu) : '—'}</strong></div>
        {renderBars(cpuValues, cpuPeak, 'CPU', 'cpu')}
      </div>
      <div className="monitor-mini-series">
        <div className="monitor-mini-series-label"><span><i className="memory" />RAM</span><strong>{Number.isFinite(latestMemory) ? formatPercent(latestMemory) : '—'}</strong></div>
        {renderBars(memoryValues, memoryPeak, 'RAM', 'memory')}
      </div>
    </div>
  );
}

function ContainerRow({ container, selected, onSelect, history }) {
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
      <td>
        <div className="monitor-state-cell">
          <span className={`monitor-state ${running ? 'running' : 'stopped'}`}>{running ? 'Ishlayapti' : 'To‘xtagan'}</span>
          {container.status && <small>{container.status}</small>}
        </div>
      </td>
      <td>{running ? formatPercent(Number(container.cpuPercent)) : '—'}</td>
      <td>
        {running ? (
          <div className="monitor-table-memory">
            <span>{formatPercent(Number(container.memPercent))}</span>
            <small>{formatBytes(Number(container.memUsage))} / {formatBytes(Number(container.memLimit))}</small>
          </div>
        ) : '—'}
      </td>
      <td><ContainerHistoryBars container={container} history={history} /></td>
      <td>{formatBytes(Number(container.networkRxBytes))}</td>
      <td>{formatBytes(Number(container.networkTxBytes))}</td>
    </tr>
  );
}

export default function MonitorDashboard({ onBack, onSessionExpired, containers = [] }) {
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState([]);
  const [speedTests, setSpeedTests] = useState([]);
  const [latestSpeedTest, setLatestSpeedTest] = useState(null);
  const [rangeKey, setRangeKey] = useState('6h');
  const [customFrom, setCustomFrom] = useState(() => dateTimeInputValue(new Date(Date.now() - 6 * HOUR_MS)));
  const [customTo, setCustomTo] = useState(() => dateTimeInputValue(new Date()));
  const [customRange, setCustomRange] = useState(null);
  const [error, setError] = useState('');
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [speedTestLoading, setSpeedTestLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [selectedContainerId, setSelectedContainerId] = useState('');
  // Container table order: running first, then by the chosen column
  const [sort, setSort] = useState({ key: 'cpu', direction: 'desc' });
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
      const tests = body.speedTests || [];
      setSpeedTests(tests);
      setLatestSpeedTest(tests[tests.length - 1] || null);
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Tarixiy ko‘rsatkichlarni olib bo‘lmadi');
    } finally {
      historyBusy.current = false;
      setHistoryLoading(false);
    }
  }, [rangeKey, customRange]);

  const runSpeedTest = useCallback(async () => {
    if (speedTestLoading) return;
    setSpeedTestLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/monitor/speedtest`, {
        method: 'POST',
        headers: authHeaders()
      });
      if (response.status === 401) {
        onSessionExpiredRef.current();
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Tezlik testi bajarilmadi (${response.status})`);
      setLatestSpeedTest(body);
      setSpeedTests(current => [...current.filter(item => item.timestamp !== body.timestamp), body].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)));
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Internet tezligini o‘lchab bo‘lmadi');
    } finally {
      setSpeedTestLoading(false);
    }
  }, [speedTestLoading]);

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
  const loadPercent = host?.cpu?.cores
    ? (Number(host.cpu.loadAvg?.[0]) / host.cpu.cores) * 100
    : null;
  const sortedContainers = useMemo(() => {
    const valueOf = {
      name: item => item.name || '',
      cpu: item => Number(item.cpuPercent || 0),
      memory: item => Number(item.memPercent || 0),
      rx: item => Number(item.networkRxBytes || 0),
      tx: item => Number(item.networkTxBytes || 0)
    }[sort.key];
    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...containers].sort((a, b) => {
      if ((a.state === 'running') !== (b.state === 'running')) return a.state === 'running' ? -1 : 1;
      const left = valueOf(a);
      const right = valueOf(b);
      const order = typeof left === 'string' ? left.localeCompare(right) : left - right;
      return order * factor || (a.name || '').localeCompare(b.name || '');
    });
  }, [containers, sort]);

  function sortBy(key) {
    setSort(current => (current.key === key
      ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
      : { key, direction: key === 'name' ? 'asc' : 'desc' }));
  }

  function sortHeader(id, children) {
    const active = sort.key === id;
    return (
      <th key={id} aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className={`monitor-sort ${active ? 'active' : ''}`} onClick={() => sortBy(id)}>
          {children}<span aria-hidden="true">{active ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ' ↕'}</span>
        </button>
      </th>
    );
  }
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
        <div className="monitor-metric-grid monitor-gauge-grid">
          <GaugeMetricCard
            title="CPU bandligi"
            value={formatPercent(host?.cpu?.percent)}
            percent={host?.cpu?.percent}
            caption="CPU Busy"
            detail={`${host?.cpu?.cores ?? '—'} yadro`}
            samples={history}
            series={serverCpuSeries}
            rangeMs={rangeMs}
            formatValue={formatPercent}
            maxValue={100}
            tone="cpu"
          />
          <GaugeMetricCard
            title="Tizim yuklamasi"
            value={formatPercent(loadPercent)}
            percent={loadPercent}
            caption="System Load"
            detail={`load ${host?.cpu?.loadAvg?.[0]?.toFixed?.(2) ?? '—'} · ${host?.cpu?.cores ?? '—'} yadro`}
            samples={history}
            series={[{ key: 'load', label: 'Load', color: '#f4a340', value: sample => {
              const load = sample.host?.cpu?.loadAvg?.[0];
              const cores = sample.host?.cpu?.cores;
              return Number.isFinite(load) && cores ? (load / cores) * 100 : null;
            } }]}
            rangeMs={rangeMs}
            formatValue={formatPercent}
            maxValue={100}
            tone="load"
          />
          <GaugeMetricCard
            title="Xotira (RAM)"
            value={formatPercent(host?.memory?.percent)}
            percent={host?.memory?.percent}
            caption="RAM Used"
            detail={`${formatBytes(host?.memory?.used)} / ${formatBytes(host?.memory?.total)} ishlatilgan`}
            samples={history}
            series={serverMemorySeries}
            rangeMs={rangeMs}
            formatValue={formatPercent}
            maxValue={100}
            tone="memory"
          />
          <GaugeMetricCard
            title="Swap ishlatilishi"
            value={formatPercent(host?.swap?.percent)}
            percent={host?.swap?.percent}
            caption="SWAP Used"
            detail={`${formatBytes(host?.swap?.used)} / ${formatBytes(host?.swap?.total)}`}
            samples={history}
            series={[{ key: 'swap', label: 'Swap', color: '#ad7bff', value: sample => sample.host?.swap?.percent }]}
            rangeMs={rangeMs}
            formatValue={formatPercent}
            maxValue={100}
            tone="swap"
          />
          <GaugeMetricCard
            title="Root disk bandligi"
            value={formatPercent(host?.disk?.percent)}
            percent={host?.disk?.percent}
            caption="Root FS Used"
            detail={`${formatBytes(host?.disk?.used)} / ${formatBytes(host?.disk?.total)} · ${formatBytes(host?.disk?.available)} bo‘sh`}
            samples={history}
            series={serverDiskSeries}
            rangeMs={rangeMs}
            formatValue={formatPercent}
            maxValue={100}
            tone="disk"
          />
        </div>
      </section>

      <section className="monitor-section">
        <div className="monitor-section-heading">
          <div><h2>Tarmoq</h2><p>Joriy trafik oqimi va serverdan internet tezligi</p></div>
        </div>
        <div className="monitor-network-grid">
          <MetricCard
            title="Joriy tarmoq trafigi"
            value={hostNetworkValue}
            detail={networkScope}
            samples={history}
            series={serverNetworkSeries}
            rangeMs={rangeMs}
            formatValue={formatRate}
            tone="network"
          />
          <SpeedTestCard tests={speedTests} rangeMs={rangeMs} running={speedTestLoading} latest={latestSpeedTest} onRun={runSpeedTest} />
        </div>
        {history.length === 0 && !historyLoading && <p className="monitor-history-empty">Hozircha tanlangan davr uchun saqlangan o‘lchov yo‘q. Yangi tarix keyingi daqiqalik o‘lchovlardan yig‘iladi.</p>}
      </section>

      <section className="monitor-section">
        <div className="monitor-section-heading monitor-container-heading">
          <div><h2>Containerlar</h2><p>Joriy CPU, RAM va ishga tushgandan beri tarmoq trafigi · ustun nomini bosib saralang, qatorni bosib tarixini oching</p></div>
          <span className="monitor-sample-count">{sortedContainers.filter(item => item.state === 'running').length} / {sortedContainers.length} ishlayapti</span>
        </div>
        <div className="monitor-table-wrap">
          <table className="monitor-table">
            <thead>
              <tr>
                {sortHeader('name', 'Container')}
                <th>Holat</th>
                {sortHeader('cpu', 'CPU')}
                {sortHeader('memory', 'RAM')}
                <th>CPU / RAM tarixi</th>
                {sortHeader('rx', 'Qabul qildi')}
                {sortHeader('tx', 'Yubordi')}
              </tr>
            </thead>
            <tbody>
              {sortedContainers.map(container => {
                const id = container.fullId || container.id;
                return <ContainerRow key={id} container={container} selected={id === activeContainerId} onSelect={() => setSelectedContainerId(id)} history={history} />;
              })}
              {!sortedContainers.length && !snapshotLoading && <tr><td colSpan="7" className="monitor-empty">Container topilmadi</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="monitor-section monitor-container-history">
        <div className="monitor-section-heading">
          <div><h2>Container tarixi</h2><p>{activeContainer?.name || latestContainerSample?.name || 'Tanlangan container'} · tanlangan vaqt bo‘yicha CPU, RAM va tarmoq</p></div>
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
