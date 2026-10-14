import React, { useCallback, useEffect, useRef, useState } from 'react';
import './MonitorDashboard.css';

const API_URL = process.env.REACT_APP_API_URL || '';
const POLL_INTERVAL_MS = 10000;
const MAX_HISTORY = 120;
const HISTORY_KEY = 'docker-log-viewer-monitor-history';

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem('token') || ''}` };
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(1)} ${units[unit]}`;
}

function percentage(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : 'Kutilmoqda';
}

function MetricChart({ values, color }) {
  const points = values
    .map((value, index) => ({ value, index }))
    .filter(point => Number.isFinite(point.value));

  if (points.length < 2) {
    return <div className="monitor-chart-empty">Ko‘rsatkichlar yig‘ilmoqda…</div>;
  }

  const line = points.map((point, index) => {
    const x = (index / (points.length - 1)) * 100;
    const y = 96 - (Math.max(0, Math.min(100, point.value)) / 100) * 88;
    return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');
  const area = `${line} L 100 100 L 0 100 Z`;

  return (
    <svg className="monitor-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Oxirgi o‘lchovlar grafigi">
      <path className="monitor-chart-grid" d="M0 8 H100 M0 52 H100 M0 96 H100" />
      <path d={area} fill={color} opacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function MetricCard({ title, value, detail, values, color }) {
  return (
    <article className="monitor-metric-card">
      <div className="monitor-metric-heading">
        <span>{title}</span>
        <strong>{value}</strong>
      </div>
      <div className="monitor-metric-detail">{detail}</div>
      <MetricChart values={values} color={color} />
      <div className="monitor-chart-caption">Oxirgi 20 daqiqa · 10 soniyada yangilanadi</div>
    </article>
  );
}

function ContainerRow({ container }) {
  const running = container.state === 'running';
  const memoryPercent = container.memory?.percent;
  return (
    <tr>
      <td>
        <div className="monitor-container-name">{container.name}</div>
        <div className="monitor-container-id">{container.shortId}</div>
      </td>
      <td><span className={`monitor-state ${running ? 'running' : 'stopped'}`}>{container.state}</span></td>
      <td>{running ? percentage(container.cpuPercent) : '—'}</td>
      <td>
        {running && container.memory ? (
          <div className="monitor-memory-cell">
            <div className="monitor-memory-label">
              <span>{percentage(memoryPercent)}</span>
              <span>{formatBytes(container.memory.used)} / {formatBytes(container.memory.limit)}</span>
            </div>
            <div className="monitor-progress"><span style={{ width: `${Math.min(100, Math.max(0, memoryPercent || 0))}%` }} /></div>
          </div>
        ) : '—'}
      </td>
      <td className="monitor-container-status">{container.health || container.status || '—'}</td>
    </tr>
  );
}

export default function MonitorDashboard({ onBack, onSessionExpired, containers = [] }) {
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState(() => {
    try {
      const cutoff = Date.now() - MAX_HISTORY * POLL_INTERVAL_MS;
      return JSON.parse(sessionStorage.getItem(HISTORY_KEY) || '[]')
        .filter(item => Number.isFinite(Date.parse(item.timestamp)) && Date.parse(item.timestamp) >= cutoff)
        .slice(-MAX_HISTORY);
    } catch {
      return [];
    }
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const busy = useRef(false);

  useEffect(() => {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }, [history]);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const response = await fetch(`${API_URL}/api/monitor/snapshot`, { headers: authHeaders() });
      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Monitoring so‘rovi bajarilmadi (${response.status})`);
      }
      const data = await response.json();
      setSnapshot(data);
      setHistory(previous => [...previous, data].slice(-MAX_HISTORY));
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Monitoring ma’lumotlarini olib bo‘lmadi');
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [onSessionExpired]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const host = snapshot?.host;
  const monitoredContainers = [...containers].sort((a, b) => {
    if ((a.state === 'running') !== (b.state === 'running')) return a.state === 'running' ? -1 : 1;
    return (b.cpuPercent || 0) - (a.cpuPercent || 0);
  });

  return (
    <div className="monitor-page">
      <div className="monitor-page-header">
        <div>
          <div className="monitor-eyebrow">SERVER VA DOCKER</div>
          <h1>Monitor</h1>
          <p>{host?.hostname || 'Server ko‘rsatkichlari va containerlar holati'}</p>
        </div>
        <div className="monitor-header-actions">
          <span className="monitor-updated">{snapshot ? `Yangilandi: ${new Date(snapshot.timestamp).toLocaleTimeString()}` : 'Ulanmoqda…'}</span>
          <button className="monitor-refresh-btn" onClick={refresh} disabled={loading}>Yangilash</button>
          <button className="monitor-back-btn" onClick={onBack}>Loglarga qaytish</button>
        </div>
      </div>

      {error && <div className="monitor-error">{error}</div>}

      <section className="monitor-section">
        <div className="monitor-section-heading">
          <div><h2>Server resurslari</h2><p>CPU, xotira va disk bandligi</p></div>
          <span>{history.length} ta o‘lchov</span>
        </div>
        <div className="monitor-metric-grid">
          <MetricCard
            title="CPU"
            value={percentage(host?.cpu?.percent)}
            detail={`${host?.cpu?.cores ?? '—'} yadro · load ${host?.cpu?.loadAvg?.[0]?.toFixed?.(2) ?? '—'}`}
            values={history.map(item => item.host?.cpu?.percent)}
            color="#58a6ff"
          />
          <MetricCard
            title="RAM"
            value={percentage(host?.memory?.percent)}
            detail={`${formatBytes(host?.memory?.used)} / ${formatBytes(host?.memory?.total)} · bo‘sh ${formatBytes(host?.memory?.free)}`}
            values={history.map(item => item.host?.memory?.percent)}
            color="#a371f7"
          />
          <MetricCard
            title="Disk"
            value={percentage(host?.disk?.percent)}
            detail={`${formatBytes(host?.disk?.used)} / ${formatBytes(host?.disk?.total)} · bo‘sh ${formatBytes(host?.disk?.available)}`}
            values={history.map(item => item.host?.disk?.percent)}
            color="#3fb950"
          />
        </div>
      </section>

      <section className="monitor-section monitor-containers-section">
        <div className="monitor-section-heading">
          <div><h2>Containerlar</h2><p>CPU va xotira sarfi bo‘yicha joriy holat</p></div>
          <span>{monitoredContainers.filter(item => item.state === 'running').length} ishlayapti / {monitoredContainers.length} jami</span>
        </div>
        <div className="monitor-table-wrap">
          <table className="monitor-table">
            <thead><tr><th>Container</th><th>Holat</th><th>CPU</th><th>RAM</th><th>Health / status</th></tr></thead>
            <tbody>
              {monitoredContainers.map(container => (
                <ContainerRow
                  key={container.id}
                  container={{
                    ...container,
                    shortId: container.id,
                    cpuPercent: Number(container.cpuPercent),
                    memory: { used: container.memUsage, limit: container.memLimit, percent: Number(container.memPercent) }
                  }}
                />
              ))}
              {!monitoredContainers.length && !loading && <tr><td colSpan="5" className="monitor-empty">Container topilmadi</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
