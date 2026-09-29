import React, { useState } from 'react';
import './Login.css';

const API_URL = process.env.REACT_APP_API_URL || '';
const MIN_PASSWORD_LENGTH = 12;

function ChangePassword({ forced, onChanged, onCancel, onSessionExpired }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_URL}/api/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token') || ''}`
        },
        body: JSON.stringify({ currentPassword, newPassword })
      });

      if (response.status === 401) {
        onSessionExpired();
        return;
      }

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to change password');
      }

      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      onChanged(data.user, data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-box">
        <div className="login-header">
          <h1>{forced ? 'Choose a new password' : 'Change password'}</h1>
          <p>
            {forced
              ? 'Your current password was issued by an administrator. Set your own password to continue.'
              : 'Enter your current password and choose a new one. Your other sessions will be signed out.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {error && <div className="login-error">{error}</div>}

          <div className="form-group">
            <label htmlFor="current-password">Current password</label>
            <input
              type="password"
              id="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="new-password">New password</label>
            <input
              type="password"
              id="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
            <p className="login-hint">At least {MIN_PASSWORD_LENGTH} characters, must not contain your username.</p>
          </div>

          <div className="form-group">
            <label htmlFor="confirm-password">Confirm new password</label>
            <input
              type="password"
              id="confirm-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Saving...' : 'Change password'}
          </button>
          <button type="button" className="login-secondary-btn" onClick={onCancel}>
            {forced ? 'Sign out' : 'Cancel'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default ChangePassword;
