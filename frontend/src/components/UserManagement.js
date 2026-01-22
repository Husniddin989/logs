import React, { useState, useEffect, useCallback } from 'react';
import './UserManagement.css';

const API_URL = process.env.REACT_APP_API_URL || '';

const getAuthHeaders = () => {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    'Authorization': token ? `Bearer ${token}` : ''
  };
};

function UserManagement({ onBack, currentUser }) {
  const [users, setUsers] = useState([]);
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    role: 'user',
    allowedContainers: []
  });

  // Fetch users
  const fetchUsers = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/users`, {
        headers: getAuthHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        setUsers(data);
      }
    } catch (err) {
      setError('Failed to fetch users');
    }
  }, []);

  // Fetch containers for permission selection
  const fetchContainers = useCallback(async () => {
    try {
      const response = await fetch(`${API_URL}/api/containers`, {
        headers: getAuthHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        setContainers(data);
      }
    } catch (err) {
      console.error('Failed to fetch containers');
    }
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([fetchUsers(), fetchContainers()]);
      setLoading(false);
    };
    loadData();
  }, [fetchUsers, fetchContainers]);

  const resetForm = () => {
    setFormData({
      username: '',
      password: '',
      role: 'user',
      allowedContainers: []
    });
    setEditingUser(null);
    setShowForm(false);
  };

  const handleEdit = (user) => {
    setEditingUser(user);
    setFormData({
      username: user.username,
      password: '',
      role: user.role,
      allowedContainers: user.allowedContainers || []
    });
    setShowForm(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    try {
      const url = editingUser
        ? `${API_URL}/api/users/${editingUser.id}`
        : `${API_URL}/api/users`;

      const method = editingUser ? 'PUT' : 'POST';

      const body = { ...formData };
      if (!body.password) delete body.password;

      const response = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        body: JSON.stringify(body)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Operation failed');
      }

      setSuccess(editingUser ? 'User updated successfully' : 'User created successfully');
      resetForm();
      fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (userId) => {
    if (!window.confirm('Are you sure you want to delete this user?')) return;

    setError('');
    setSuccess('');

    try {
      const response = await fetch(`${API_URL}/api/users/${userId}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Delete failed');
      }

      setSuccess('User deleted successfully');
      fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleContainer = (containerId) => {
    setFormData(prev => {
      const current = prev.allowedContainers;
      if (current.includes(containerId)) {
        return { ...prev, allowedContainers: current.filter(c => c !== containerId) };
      } else {
        return { ...prev, allowedContainers: [...current, containerId] };
      }
    });
  };

  const toggleAllContainers = () => {
    if (formData.allowedContainers.includes('*')) {
      setFormData(prev => ({ ...prev, allowedContainers: [] }));
    } else {
      setFormData(prev => ({ ...prev, allowedContainers: ['*'] }));
    }
  };

  if (loading) {
    return (
      <div className="user-management">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  return (
    <div className="user-management">
      <header className="um-header">
        <button className="back-btn" onClick={onBack}>
          ← Back to Logs
        </button>
        <h1>User Management</h1>
        <button className="add-btn" onClick={() => setShowForm(true)}>
          + Add User
        </button>
      </header>

      {error && <div className="um-error">{error}</div>}
      {success && <div className="um-success">{success}</div>}

      {showForm && (
        <div className="um-form-overlay">
          <div className="um-form-container">
            <h2>{editingUser ? 'Edit User' : 'Add New User'}</h2>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>Username</label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  required
                  disabled={editingUser?.username === 'admin'}
                />
              </div>

              <div className="form-group">
                <label>{editingUser ? 'New Password (leave empty to keep)' : 'Password'}</label>
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  required={!editingUser}
                />
              </div>

              <div className="form-group">
                <label>Role</label>
                <select
                  value={formData.role}
                  onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                  disabled={editingUser?.username === 'admin'}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              {formData.role === 'user' && (
                <div className="form-group">
                  <label>Allowed Containers</label>
                  <div className="um-container-list">
                    <label className="container-checkbox all-containers">
                      <input
                        type="checkbox"
                        checked={formData.allowedContainers.includes('*')}
                        onChange={toggleAllContainers}
                      />
                      <span>All Containers (*)</span>
                    </label>

                    {!formData.allowedContainers.includes('*') && containers.map(container => (
                      <label key={container.fullId} className="container-checkbox">
                        <input
                          type="checkbox"
                          checked={formData.allowedContainers.includes(container.name) ||
                                   formData.allowedContainers.includes(container.fullId)}
                          onChange={() => toggleContainer(container.name)}
                        />
                        <span className={`container-name ${container.state}`}>
                          {container.name}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={resetForm}>
                  Cancel
                </button>
                <button type="submit" className="submit-btn">
                  {editingUser ? 'Update' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="users-table">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Allowed Containers</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr key={user.id}>
                <td className="username-cell">
                  {user.username}
                  {user.id === currentUser.id && <span className="you-badge">You</span>}
                </td>
                <td>
                  <span className={`role-badge ${user.role}`}>{user.role}</span>
                </td>
                <td className="containers-cell">
                  {user.role === 'admin' ? (
                    <span className="all-access">All containers</span>
                  ) : user.allowedContainers?.includes('*') ? (
                    <span className="all-access">All containers</span>
                  ) : user.allowedContainers?.length > 0 ? (
                    <span className="container-count">
                      {user.allowedContainers.length} container(s)
                    </span>
                  ) : (
                    <span className="no-access">No access</span>
                  )}
                </td>
                <td className="actions-cell">
                  <button className="edit-btn" onClick={() => handleEdit(user)}>
                    Edit
                  </button>
                  {user.id !== currentUser.id && (
                    <button className="delete-btn" onClick={() => handleDelete(user.id)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default UserManagement;
