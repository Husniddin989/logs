import React, { useState, useEffect, useCallback, useRef } from 'react';
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

const CHECK_OPTIONS = [
  ['serverCpu', 'Server CPU'],
  ['serverMemory', 'Server RAM'],
  ['serverDisk', 'Server disk (joy)'],
  ['docker', 'Docker API'],
  ['containerState', 'Container holati (to‘xtadi, crash, unhealthy, restart)'],
  ['containerResources', 'Container CPU / RAM']
];

const SERVICE_DEFAULTS = {
  postgres: { name: 'postgres', port: 5432, user: 'postgres' },
  redis: { name: 'redis', port: 6379, user: '' }
};

let nextRowKey = 1;

function serviceRow(service) {
  return {
    key: `row-${nextRowKey++}`,
    id: service.id,
    type: service.type,
    name: service.name || '',
    host: service.host || '',
    port: String(service.port || SERVICE_DEFAULTS[service.type].port),
    user: service.user || '',
    database: service.database || '',
    ssl: Boolean(service.ssl),
    enabled: service.enabled !== false,
    hasPassword: Boolean(service.hasPassword),
    password: '',
    clearPassword: false
  };
}

function formFromSettings(settings) {
  return {
    enabled: settings.enabled,
    botToken: '',
    chatId: settings.chatId || '',
    hostname: settings.hostname || '',
    serverIp: settings.serverIp || '',
    timezone: settings.timezone || 'Asia/Tashkent',
    messageTemplate: settings.messageTemplate || '',
    checks: { ...settings.checks },
    services: (settings.services || []).map(serviceRow),
    intervalSeconds: toDurationInput(settings.intervalSeconds),
    renotifySeconds: toDurationInput(settings.renotifySeconds),
    summarySeconds: toDurationInput(settings.summarySeconds),
    ignoreContainers: settings.ignoreContainers || [],
    thresholds: { ...settings.thresholds }
  };
}

// What the API expects for one Postgres / Redis row. An empty password keeps
// the saved one.
function servicePayload(row) {
  const body = {
    id: row.id,
    type: row.type,
    name: row.name,
    host: row.host,
    port: row.port,
    user: row.user,
    database: row.database,
    ssl: row.ssl,
    enabled: row.enabled
  };
  if (row.clearPassword) body.clearPassword = true;
  else if (row.password) body.password = row.password;
  return body;
}

// Renders the Telegram HTML subset the backend produces (already escaped,
// only <b> <i> <u> <s> <code>) as React elements, without innerHTML.
function decodeEntities(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function TelegramText({ html }) {
  const root = { tag: null, children: [] };
  const stack = [root];
  html.split(/(<\/?(?:b|i|u|s|code)>)/).forEach((part, index) => {
    const tag = /^<(\/?)(b|i|u|s|code)>$/.exec(part);
    if (!tag) {
      if (part) stack[stack.length - 1].children.push(decodeEntities(part));
    } else if (!tag[1]) {
      const node = { tag: tag[2], children: [], key: index };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (stack.length > 1) {
      stack.pop();
    }
  });
  const render = (node, key) => (typeof node === 'string'
    ? node
    : React.createElement(node.tag, { key: node.key ?? key }, node.children.map(render)));
  return <>{root.children.map(render)}</>;
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
  const [templateHelp, setTemplateHelp] = useState({ default: '', placeholders: {} });
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [serviceResults, setServiceResults] = useState({});
  const templateRef = useRef(null);

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
        if (data.template) setTemplateHelp(data.template);
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

  // Live preview of the message format, rendered by the backend
  const previewTemplate = form?.messageTemplate;
  const previewHostname = form?.hostname;
  const previewIp = form?.serverIp;
  const previewTimezone = form?.timezone;
  useEffect(() => {
    if (previewTemplate === undefined) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await request('POST', '/api/alerts/preview', {
          messageTemplate: previewTemplate,
          hostname: previewHostname,
          serverIp: previewIp,
          timezone: previewTimezone
        });
        if (!cancelled) { setPreview(data); setPreviewError(''); }
      } catch (err) {
        if (!cancelled) setPreviewError(err.message);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [request, previewTemplate, previewHostname, previewIp, previewTimezone]);

  const update = (field, value) => setForm(prev => ({ ...prev, [field]: value }));
  const updateCheck = (key, value) =>
    setForm(prev => ({ ...prev, checks: { ...prev.checks, [key]: value } }));

  const insertPlaceholder = (name) => {
    const token = `{${name}}`;
    const input = templateRef.current;
    const text = form.messageTemplate;
    const start = input ? input.selectionStart : text.length;
    const end = input ? input.selectionEnd : text.length;
    update('messageTemplate', text.slice(0, start) + token + text.slice(end));
    if (input) {
      // Put the cursor right after the inserted placeholder
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(start + token.length, start + token.length);
      });
    }
  };

  const addService = (type) => {
    setForm(prev => ({
      ...prev,
      services: [...prev.services, serviceRow({ type, ...SERVICE_DEFAULTS[type], host: '' })]
    }));
  };
  const updateService = (key, field, value) => {
    setForm(prev => ({
      ...prev,
      services: prev.services.map(row => (row.key === key ? { ...row, [field]: value } : row))
    }));
  };
  const removeService = (key) => {
    setForm(prev => ({ ...prev, services: prev.services.filter(row => row.key !== key) }));
  };
  const testService = async (row) => {
    setServiceResults(prev => ({ ...prev, [row.key]: { pending: true } }));
    try {
      const result = await request('POST', '/api/alerts/services/test', servicePayload(row));
      setServiceResults(prev => ({ ...prev, [row.key]: result }));
    } catch (err) {
      setServiceResults(prev => ({ ...prev, [row.key]: { ok: false, level: 'critical', detail: err.message } }));
    }
  };
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
        serverIp: form.serverIp,
        timezone: form.timezone,
        messageTemplate: form.messageTemplate,
        checks: form.checks,
        services: form.services.map(servicePayload),
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
      chatId: form.chatId.trim() || undefined,
      hostname: form.hostname,
      serverIp: form.serverIp,
      timezone: form.timezone,
      messageTemplate: form.messageTemplate
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
                placeholder="logs.example.com"
                maxLength={100}
              />
            </div>

            <div className="form-group">
              <label>Server IP (xabarlarda)</label>
              <input
                type="text"
                value={form.serverIp}
                onChange={(e) => update('serverIp', e.target.value)}
                placeholder="203.0.113.10"
                maxLength={100}
              />
              <p className="form-hint">Container ichidan serverning tashqi IP sini bilib bo‘lmaydi — shu yerga yozing.</p>
            </div>

            <div className="form-group">
              <label>Vaqt zonasi (timedown / timeup)</label>
              <input
                type="text"
                value={form.timezone}
                onChange={(e) => update('timezone', e.target.value)}
                placeholder="Asia/Tashkent"
                maxLength={64}
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
          <h2>Xabar ko‘rinishi</h2>
          <p className="form-hint">
            Har bir alert shu shablon bo‘yicha yuboriladi. {'{nom}'} o‘rniga qiymat qo‘yiladi;
            &lt;b&gt;, &lt;i&gt;, &lt;u&gt;, &lt;s&gt;, &lt;code&gt; teglari ishlaydi.
          </p>
          <div className="template-editor">
            <div className="form-group">
              <textarea
                ref={templateRef}
                className="template-input"
                value={form.messageTemplate}
                onChange={(e) => update('messageTemplate', e.target.value)}
                rows={11}
                maxLength={2000}
                spellCheck={false}
              />
              <div className="placeholder-chips">
                {Object.entries(templateHelp.placeholders || {}).map(([name, description]) => (
                  <button
                    type="button"
                    key={name}
                    className="chip"
                    title={description}
                    onClick={() => insertPlaceholder(name)}
                  >
                    {`{${name}}`}
                  </button>
                ))}
              </div>
              {templateHelp.default && form.messageTemplate !== templateHelp.default && (
                <button type="button" className="link-btn neutral" onClick={() => update('messageTemplate', templateHelp.default)}>
                  Standart shablonga qaytarish
                </button>
              )}
            </div>
            <div className="template-preview">
              <label>Namuna: muammo</label>
              <pre className="telegram-preview">
                {previewError ? <span className="preview-error">{previewError}</span> : preview && <TelegramText html={preview.down} />}
              </pre>
              <label>Namuna: tiklandi</label>
              <pre className="telegram-preview">
                {!previewError && preview && <TelegramText html={preview.up} />}
              </pre>
            </div>
          </div>
        </section>

        <section className="alert-section">
          <h2>Nimalar haqida alert yuborilsin</h2>
          <div className="check-toggles">
            {CHECK_OPTIONS.map(([key, label]) => (
              <label key={key} className="alert-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(form.checks[key])}
                  onChange={(e) => updateCheck(key, e.target.checked)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="alert-section">
          <h2>Postgres / Redis</h2>
          <p className="form-hint">
            Har tekshiruvda ulanib ko‘riladi: ulanib bo‘lmasa 🔴 CRITICAL, Postgres ulanishlari (max_connections dan)
            yoki Redis xotirasi (maxmemory dan) chegaradan oshsa 🟡 / 🔴. Host — container nomi (bitta Docker tarmog‘ida bo‘lsa),
            host.docker.internal yoki server IP.
          </p>
          {form.services.length === 0 && <p className="form-hint">Hali qo‘shilmagan.</p>}
          {form.services.map(row => {
            const result = serviceResults[row.key];
            return (
              <div key={row.key} className={`service-row ${row.enabled ? '' : 'disabled'}`}>
                <div className="service-head">
                  <span className={`service-type ${row.type}`}>{row.type === 'postgres' ? 'Postgres' : 'Redis'}</span>
                  <label className="alert-toggle">
                    <input type="checkbox" checked={row.enabled} onChange={(e) => updateService(row.key, 'enabled', e.target.checked)} />
                    <span>Kuzatish</span>
                  </label>
                  <span className="service-buttons">
                    <button type="button" className="cancel-btn" onClick={() => testService(row)} disabled={!row.host || result?.pending}>
                      {result?.pending ? 'Tekshirilmoqda...' : 'Tekshirish'}
                    </button>
                    <button type="button" className="link-btn" onClick={() => removeService(row.key)}>O‘chirish</button>
                  </span>
                </div>
                <div className="alert-grid service-grid">
                  <div className="form-group">
                    <label>Nomi</label>
                    <input type="text" value={row.name} maxLength={50} onChange={(e) => updateService(row.key, 'name', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>Host</label>
                    <input type="text" value={row.host} placeholder={row.type} onChange={(e) => updateService(row.key, 'host', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>Port</label>
                    <input type="number" min="1" max="65535" value={row.port} onChange={(e) => updateService(row.key, 'port', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>Foydalanuvchi</label>
                    <input
                      type="text"
                      value={row.user}
                      placeholder={row.type === 'redis' ? 'ixtiyoriy (ACL)' : ''}
                      onChange={(e) => updateService(row.key, 'user', e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div className="form-group">
                    <label>Parol</label>
                    <input
                      type="password"
                      value={row.password}
                      disabled={row.clearPassword}
                      placeholder={row.hasPassword && !row.clearPassword ? 'Saqlangan — bo‘sh qoldirsangiz o‘zgarmaydi' : ''}
                      onChange={(e) => updateService(row.key, 'password', e.target.value)}
                      autoComplete="new-password"
                    />
                    {row.hasPassword && (
                      <label className="inline-check">
                        <input type="checkbox" checked={row.clearPassword} onChange={(e) => updateService(row.key, 'clearPassword', e.target.checked)} />
                        <span>Saqlangan parolni o‘chirish</span>
                      </label>
                    )}
                  </div>
                  {row.type === 'postgres' && (
                    <div className="form-group">
                      <label>Database</label>
                      <input type="text" value={row.database} placeholder={row.user || 'postgres'} onChange={(e) => updateService(row.key, 'database', e.target.value)} />
                      <label className="inline-check">
                        <input type="checkbox" checked={row.ssl} onChange={(e) => updateService(row.key, 'ssl', e.target.checked)} />
                        <span>SSL</span>
                      </label>
                    </div>
                  )}
                </div>
                {result && !result.pending && (
                  <div className={`service-result level-${result.level}`}>
                    {LEVEL_ICON[result.level]} {result.detail}
                  </div>
                )}
              </div>
            );
          })}
          <div className="alert-actions">
            <button type="button" className="cancel-btn" onClick={() => addService('postgres')}>+ Postgres qo‘shish</button>
            <button type="button" className="cancel-btn" onClick={() => addService('redis')}>+ Redis qo‘shish</button>
          </div>
          <p className="form-hint">O‘zgarishlar «Saqlash» bosilgandan keyin kuchga kiradi.</p>
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
              {form.checks.containerResources && CONTAINER_THRESHOLDS.map(([key, label]) => (
                <tr key={key}>
                  <td>Container {label}</td>
                  <td><input type="number" min="1" max="100" value={form.thresholds[`${key}Warn`]} onChange={(e) => updateThreshold(`${key}Warn`, e.target.value)} /></td>
                  <td><input type="number" min="1" max="100" value={form.thresholds[`${key}Critical`]} onChange={(e) => updateThreshold(`${key}Critical`, e.target.value)} /></td>
                </tr>
              ))}
              <tr>
                <td>Postgres ulanishlar / Redis xotira</td>
                <td><input type="number" min="1" max="100" value={form.thresholds.serviceWarn} onChange={(e) => updateThreshold('serviceWarn', e.target.value)} /></td>
                <td><input type="number" min="1" max="100" value={form.thresholds.serviceCritical} onChange={(e) => updateThreshold('serviceCritical', e.target.value)} /></td>
              </tr>
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
          <button type="button" className="cancel-btn" onClick={() => { setForm(formFromSettings(settings)); setServiceResults({}); }} disabled={Boolean(busy)}>
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
