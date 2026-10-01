import React, { useState } from 'react';
import './ContainerActions.css';

const API_URL = process.env.REACT_APP_API_URL || '';

const LABELS = {
  start: '▶ Start',
  stop: '■ Stop',
  restart: '↻ Restart',
  remove: '🗑 Delete'
};

const DONE = {
  start: 'ishga tushirildi',
  stop: 'to‘xtatildi',
  restart: 'qayta ishga tushirildi',
  remove: 'o‘chirildi'
};

// Admin-only start / stop / restart / delete for the selected container.
// Every action needs the password re-entered once per few minutes; the
// resulting action token lives only in memory (`unlock`, held by App), never
// in localStorage.
function ContainerActions({ container, unlock, onUnlock, onChanged, onRemoved, onSessionExpired }) {
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null); // { ok, text }
  const [modal, setModal] = useState(null); // { kind: 'password' | 'remove', action }
  const [password, setPassword] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [modalError, setModalError] = useState('');

  if (container.protected) {
    return (
      <span className="container-protected" title={`Himoyalangan: ${container.protected}`}>
        🔒 himoyalangan
      </span>
    );
  }

  const running = container.state === 'running' || container.state === 'restarting';
  const unlocked = unlock && unlock.expiresAt > Date.now();

  const sessionHeaders = () => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${localStorage.getItem('token') || ''}`
  });

  const closeModal = () => {
    setModal(null);
    setPassword('');
    setConfirmName('');
    setModalError('');
  };

  const perform = async (action, actionToken, confirm) => {
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch(`${API_URL}/api/containers/${encodeURIComponent(container.fullId)}/actions`, {
        method: 'POST',
        headers: { ...sessionHeaders(), 'X-Action-Token': actionToken },
        body: JSON.stringify({ action, ...(confirm ? { confirm } : {}) })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && data.code === 'ACTION_TOKEN_REQUIRED') {
        // Expired or belongs to an older sign-in: ask for the password again
        onUnlock(null);
        setModal({ kind: 'password', action, confirm });
        return;
      }
      if (response.status === 401) {
        onSessionExpired();
        return;
      }
      if (!response.ok) {
        setMessage({ ok: false, text: data.error || `Xato (${response.status})` });
        return;
      }
      setMessage({
        ok: true,
        text: data.changed === false ? `${container.name} allaqachon shu holatda` : `${container.name} ${DONE[action]}`
      });
      if (action === 'remove') onRemoved();
      else onChanged();
    } catch (error) {
      setMessage({ ok: false, text: error.message });
    } finally {
      setBusy('');
    }
  };

  const start = (action) => {
    if (action === 'remove') {
      setModal({ kind: 'remove', action });
      return;
    }
    if ((action === 'stop' || action === 'restart') &&
        !window.confirm(`${container.name} — ${action === 'stop' ? 'to‘xtatilsinmi' : 'qayta ishga tushirilsinmi'}?`)) {
      return;
    }
    if (!unlocked) {
      setModal({ kind: 'password', action });
      return;
    }
    perform(action, unlock.token);
  };

  const submitRemove = (e) => {
    e.preventDefault();
    if (confirmName !== container.name) {
      setModalError('Nom mos kelmadi');
      return;
    }
    const confirm = confirmName;
    closeModal();
    if (!unlocked) {
      setModal({ kind: 'password', action: 'remove', confirm });
      return;
    }
    perform('remove', unlock.token, confirm);
  };

  const submitPassword = async (e) => {
    e.preventDefault();
    setModalError('');
    setBusy('unlock');
    try {
      const response = await fetch(`${API_URL}/api/auth/elevate`, {
        method: 'POST',
        headers: sessionHeaders(),
        body: JSON.stringify({ password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setModalError(data.error || `Xato (${response.status})`);
        return;
      }
      // A few seconds of margin so a request never races the expiry
      const next = { token: data.actionToken, expiresAt: Date.now() + (data.expiresIn - 5) * 1000 };
      onUnlock(next);
      const { action, confirm } = modal;
      closeModal();
      perform(action, next.token, confirm);
    } catch (error) {
      setModalError(error.message);
    } finally {
      setBusy(prev => (prev === 'unlock' ? '' : prev));
    }
  };

  const actions = running ? ['stop', 'restart'] : ['start', 'restart', 'remove'];

  return (
    <div className="container-actions">
      {actions.map(action => (
        <button
          key={action}
          type="button"
          className={`action-btn ${action}`}
          onClick={() => start(action)}
          disabled={Boolean(busy)}
        >
          {busy === action ? '...' : LABELS[action]}
        </button>
      ))}
      {unlocked && <span className="unlock-state" title="Parol tasdiqlangan, bir necha daqiqa amal qiladi">🔓</span>}
      {message && <span className={`action-message ${message.ok ? 'ok' : 'error'}`}>{message.text}</span>}

      {modal && (
        <div className="action-modal-backdrop" onClick={closeModal}>
          <div className="action-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            {modal.kind === 'password' ? (
              <form onSubmit={submitPassword}>
                <h3>Parolni tasdiqlang</h3>
                <p>
                  <b>{container.name}</b> — {LABELS[modal.action]}. Container boshqaruvi uchun parolingizni
                  qayta kiriting (bir necha daqiqa amal qiladi).
                </p>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
                {modalError && <div className="modal-error">{modalError}</div>}
                <div className="modal-buttons">
                  <button type="button" className="cancel-btn" onClick={closeModal}>Bekor qilish</button>
                  <button type="submit" className="submit-btn" disabled={!password || busy === 'unlock'}>
                    {busy === 'unlock' ? 'Tekshirilmoqda...' : 'Tasdiqlash'}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={submitRemove}>
                <h3>Containerni o‘chirish</h3>
                <p>
                  <b>{container.name}</b> butunlay o‘chiriladi (volume’lar qoladi). Tasdiqlash uchun nomini yozing:
                </p>
                <input
                  type="text"
                  value={confirmName}
                  onChange={e => setConfirmName(e.target.value)}
                  placeholder={container.name}
                  autoFocus
                />
                {modalError && <div className="modal-error">{modalError}</div>}
                <div className="modal-buttons">
                  <button type="button" className="cancel-btn" onClick={closeModal}>Bekor qilish</button>
                  <button type="submit" className="danger-btn" disabled={confirmName !== container.name}>
                    O‘chirish
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ContainerActions;
