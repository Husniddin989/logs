import React, { useState, useEffect, useCallback } from 'react';
import './UserManagement.css';
import './AlertSettings.css';

const API_URL = process.env.REACT_APP_API_URL || '';

const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    'Authorization': token ? `Bearer ${token}` : ''
  };
};

const LEVEL_ICON = { ok: '🟢', warn: '🟡', critical: '🔴' };
const LEVEL_ORDER = { critical: 0, warn: 1, ok: 2 };

// 3600 -> "1h", 90 -> "90s", 0 -> "0"
function toDurationInput(seconds) {
  if (!seconds) return '0';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

const SERVER_THRESHOLDS = [
  ['cpu', 'CPU'],
  ['mem', 'RAM'],
  ['disk', 'Disk']
];
const CONTAINER_THRESHOLDS = [
  ['containerCpu', 'CPU'],
  ['containerMem', 'RAM']
];

function formFromSettings(settings) {
  return {
    enabled: settings.enabled,
    botToken: '',
    chatId: settings.chatId || '',
    hostname: settings.hostname || '',
    intervalSeconds: toDurationInput(settings.intervalSeconds),
    renotifySeconds: toDurationInput(settings.renotifySeconds),
    summarySeconds: toDurationInput(settings.summarySeconds),
    ignoreContainers: settings.ignoreContainers || [],
    thresholds: { ...settings.thresholds }
  };
}

function AlertSettings({ onBack, onSessionExpired }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [settings, setSettings] = useState(null);
  const [source, setSource] = useState('env');
  const [status, setStatus] = useState(null);
  const [containers, setContainers] = useState([]);
  const [form, setForm] = useState(null);

  const request = useCallback(async (method, url, body) => {
    const response = await fetch(`${API_URL}${url}`, {
      method,
      headers: getAuthHeaders(),
      body: body ? JSON.stringify(body) : undefined
    });
    if (response.status === 401) {
      onSessionExpired();
      throw new Error('Sessiya tugadi');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Xato (${response.status})`);
    return data;
  }, [onSessionExpired]);

  const applyResponse = (data) => {
    setSettings(data.settings);
    setSource(data.source);
    setStatus(data.status);
    setForm(formFromSettings(data.settings));
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [data, list] = await Promise.all([
          request('GET', '/api/alerts/settings'),
          request('GET', '/api/containers').catch(() => [])
        ]);
        if (cancelled) return;
        applyResponse(data);
        setContainers(Array.isArray(list) ? list : []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [request]);

  // Keep the status table fresh while the page is open
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        setStatus(await request('GET', '/api/alerts/status'));
      } catch {
        // shown on the next explicit action
      }
    }, 30000);
    return () => clearInterval(timer);
  }, [request]);

  const update = (field, value) => setForm(prev => ({ ...prev, [field]: value }));
  const updateThreshold = (key, value) =>
    setForm(prev => ({ ...prev, thresholds: { ...prev.thresholds, [key]: value } }));

  const toggleIgnored = (name) => {
    setForm(prev => ({
      ...prev,
      ignoreContainers: prev.ignoreContainers.includes(name)
        ? prev.ignoreContainers.filter(n => n !== name)
        : [...prev.ignoreContainers, name]
    }));
  };

  const run = async (label, action) => {
    setBusy(label);
    setError('');
    setSuccess('');
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const handleSave = (e) => {
    e.preventDefault();
    run('save', async () => {
      const thresholds = Object.fromEntries(
        Object.entries(form.thresholds).map(([key, value]) => [key, Number(value)])
      );
      const body = {
        enabled: form.enabled,
        chatId: form.chatId,
        hostname: form.hostname,
        intervalSeconds: form.intervalSeconds,
        renotifySeconds: form.renotifySeconds,
        summarySeconds: form.summarySeconds,
        ignoreContainers: form.ignoreContainers,
        thresholds
      };
      // An empty token field means "keep the saved token"
      if (form.botToken.trim()) body.botToken = form.botToken.trim();
      applyResponse(await request('PUT', '/api/alerts/settings', body));
      setSuccess('Sozlamalar saqlandi');
    });
  };

  const handleClearToken = () => {
    if (!window.confirm('Saqlangan bot token o‘chirilsinmi? Alertlar o‘chiriladi.')) return;
    run('clear', async () => {
      applyResponse(await request('PUT', '/api/alerts/settings', { enabled: false, clearBotToken: true }));
      setSuccess('Bot token o‘chirildi, alertlar o‘chirildi');
    });
  };

  const handleTest = () => run('test', async () => {
    await request('POST', '/api/alerts/test', {
      botToken: form.botToken.trim() || undefined,
      chatId: form.chatId.trim() || undefined
    });
    setSuccess('Test xabari yuborildi — Telegram chatni tekshiring');
  });

  const handleReport = () => run('report', async () => {
    await request('POST', '/api/alerts/report');
    setSuccess('Holat hisoboti yuborildi');
  });

  if (loading) {
    return (
      <div className="user-management">
        <div className="loading">Yuklanmoqda...</div>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="user-management">
        <header className="um-header">
          <button className="back-btn" onClick={onBack}>← Back to Logs</button>
          <h1>Alerts</h1>
          <span />
        </header>
        <div className="um-error">{error || 'Sozlamalarni yuklab bo‘lmadi'}</div>
      </div>
    );
  }

  const checks = [...(status?.checks || [])].sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.title.localeCompare(b.title)
  );
  const containerNames = [...new Set([
    ...containers.map(c => c.name),
    ...form.ignoreContainers
  ])].sort();

  return (
    <div className="user-management alert-settings">
      <header className="um-header">
        <button className="back-btn" onClick={onBack}>← Back to Logs</button>
        <h1>Telegram Alerts</h1>
        <span className={`alert-state ${status?.running ? 'on' : 'off'}`}>
          {status?.running ? '● Ishlayapti' : '○ O‘chirilgan'}
        </span>
      </header>

      {error && <div className="um-error">{error}</div>}
      {success && <div className="um-success">{success}</div>}

      <form className="alert-body" onSubmit={handleSave}>
        <section className="alert-section">
          <h2>Telegram</h2>
          {source === 'env' && (
            <p className="form-hint">
              Hozircha qiymatlar .env dan olingan. Saqlaganingizdan keyin shu yerdagi sozlamalar ishlatiladi.
            </p>
          )}

          <label className="alert-toggle">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => update('enabled', e.target.checked)}
            />
            <span>Alertlarni yoqish</span>
          </label>

          <div className="alert-grid two">
            <div className="form-group">
              <label>Bot token</label>
              <input
                type="password"
                value={form.botToken}
                onChange={(e) => update('botToken', e.target.value)}
                placeholder={settings.hasBotToken ? `Saqlangan: ${settings.botTokenHint}` : '123456789:ABC...'}
                autoComplete="off"
              />
              <p className="form-hint">
                @BotFather dan oling. {settings.hasBotToken && 'Bo‘sh qoldirsangiz saqlangan token qoladi.'}
              </p>
              {settings.hasBotToken && (
                <button type="button" className="link-btn" onClick={handleClearToken} disabled={Boolean(busy)}>
                  Saqlangan tokenni o‘chirish
                </button>
              )}
            </div>

            <div className="form-group">
              <label>Chat ID</label>
              <input
                type="text"
                value={form.chatId}
                onChange={(e) => update('chatId', e.target.value)}
                placeholder="-1001234567890 yoki @kanal"
              />
              <p className="form-hint">
                Botni guruhga qo‘shing, so‘ng api.telegram.org/bot&lt;TOKEN&gt;/getUpdates dan "chat":{'{'}"id"{'}'} ni oling.
              </p>
            </div>

            <div className="form-group">
              <label>Server nomi (xabarlarda)</label>
              <input
                type="text"
                value={form.hostname}
                onChange={(e) => update('hostname', e.target.value)}
                placeholder="logs.ustozaibot.uz"
                maxLength={100}
              />
            </div>
          </div>

          <div className="alert-actions">
            <button type="button" className="cancel-btn" onClick={handleTest} disabled={Boolean(busy)}>
              {busy === 'test' ? 'Yuborilmoqda...' : '✉ Test xabar yuborish'}
            </button>
            <button type="button" className="cancel-btn" onClick={handleReport} disabled={Boolean(busy) || !status?.running}>
              {busy === 'report' ? 'Yuborilmoqda...' : '📋 Holat hisobotini hozir yuborish'}
            </button>
          </div>
        </section>

        <section className="alert-section">
          <h2>Vaqt</h2>
          <div className="alert-grid three">
            <div className="form-group">
              <label>Tekshiruv oralig‘i</label>
              <input type="text" value={form.intervalSeconds} onChange={(e) => update('intervalSeconds', e.target.value)} />
              <p className="form-hint">Masalan 60s, 5m (kamida 15s)</p>
            </div>
            <div className="form-group">
              <label>Qayta eslatish</label>
              <input type="text" value={form.renotifySeconds} onChange={(e) => update('renotifySeconds', e.target.value)} />
              <p className="form-hint">Muammo davom etsa qancha vaqtda qayta yuborilsin (30m)</p>
            </div>
            <div className="form-group">
              <label>Holat hisoboti</label>
              <input type="text" value={form.summarySeconds} onChange={(e) => update('summarySeconds', e.target.value)} />
              <p className="form-hint">Barcha containerlar hisoboti (24h, 0 = o‘chiq)</p>
            </div>
          </div>
        </section>

        <section className="alert-section">
          <h2>Chegaralar (%)</h2>
          <p className="form-hint">🟡 WARN chegarasidan oshsa ogohlantirish, 🔴 CRITICAL dan oshsa kritik; pastga tushsa 🟢 OK yuboriladi.</p>
          <table className="threshold-table">
            <thead>
              <tr><th /><th>🟡 WARN</th><th>🔴 CRITICAL</th></tr>
            </thead>
            <tbody>
              {SERVER_THRESHOLDS.map(([key, label]) => (
                <tr key={key}>
                  <td>Server {label}</td>
                  <td><input type="number" min="1" max="100" value={form.thresholds[`${key}Warn`]} onChange={(e) => updateThreshold(`${key}Warn`, e.target.value)} /></td>
                  <td><input type="number" min="1" max="100" value={form.thresholds[`${key}Critical`]} onChange={(e) => updateThreshold(`${key}Critical`, e.target.value)} /></td>
                </tr>
              ))}
              {CONTAINER_THRESHOLDS.map(([key, label]) => (
                <tr key={key}>
                  <td>Container {label}</td>
                  <td><input type="number" min="1" max="100" value={form.thresholds[`${key}Warn`]} onChange={(e) => updateThreshold(`${key}Warn`, e.target.value)} /></td>
                  <td><input type="number" min="1" max="100" value={form.thresholds[`${key}Critical`]} onChange={(e) => updateThreshold(`${key}Critical`, e.target.value)} /></td>
                </tr>
              ))}
              <tr>
                <td>Container restart soni</td>
                <td><input type="number" min="1" max="1000" value={form.thresholds.restartWarn} onChange={(e) => updateThreshold('restartWarn', e.target.value)} /></td>
                <td className="form-hint">xato bilan to‘xtash, OOM, unhealthy — doim CRITICAL</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="alert-section">
          <h2>E‘tiborsiz containerlar</h2>
          <p className="form-hint">Belgilangan containerlar haqida alert yuborilmaydi.</p>
          <div className="um-container-list">
            {containerNames.length === 0 && <p className="form-hint">Containerlar topilmadi.</p>}
            {containerNames.map(name => (
              <label key={name} className="container-checkbox">
                <input
                  type="checkbox"
                  checked={form.ignoreContainers.includes(name)}
                  onChange={() => toggleIgnored(name)}
                />
                <span className="container-name">{name}</span>
              </label>
            ))}
          </div>
        </section>

        <div className="alert-actions sticky">
          <button type="button" className="cancel-btn" onClick={() => setForm(formFromSettings(settings))} disabled={Boolean(busy)}>
            Bekor qilish
          </button>
          <button type="submit" className="submit-btn" disabled={Boolean(busy)}>
            {busy === 'save' ? 'Saqlanmoqda...' : 'Saqlash'}
          </button>
        </div>
      </form>

      <section className="alert-section alert-status">
        <h2>Joriy holat</h2>
        {!status?.running && <p className="form-hint">Alertlar o‘chirilgan — tekshiruvlar ishlamayapti.</p>}
        {status?.running && !status.lastRunAt && <p className="form-hint">Birinchi tekshiruv bir necha soniyada bo‘ladi.</p>}
        {status?.lastRunAt && (
          <p className="form-hint">Oxirgi tekshiruv: {new Date(status.lastRunAt).toLocaleString()}</p>
        )}
        {checks.length > 0 && (
          <div className="users-table">
            <table>
              <thead>
                <tr><th>Holat</th><th>Tekshiruv</th><th>Tafsilot</th></tr>
              </thead>
              <tbody>
                {checks.map(check => (
                  <tr key={check.key} className={`level-${check.level}`}>
                    <td>{LEVEL_ICON[check.level]} {check.level.toUpperCase()}</td>
                    <td>{check.title}</td>
                    <td>{check.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default AlertSettings;
