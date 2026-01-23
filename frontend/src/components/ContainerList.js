import React from 'react';
import './ContainerList.css';

// Format bytes to human readable
function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

// Format uptime from created date
function formatUptime(createdDate) {
  const created = new Date(createdDate);
  const now = new Date();
  const diffMs = now - created;

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function ContainerList({ containers, selectedContainer, onSelect, searchTerm = '' }) {
  // Filter containers by search term
  const filteredContainers = containers.filter(container => {
    if (!searchTerm) return true;

    const search = searchTerm.toLowerCase();
    return (
      container.name.toLowerCase().includes(search) ||
      container.image.toLowerCase().includes(search) ||
      container.id.toLowerCase().includes(search)
    );
  });

  const runningContainers = filteredContainers.filter(c => c.state === 'running');
  const stoppedContainers = filteredContainers.filter(c => c.state !== 'running');

  const renderContainer = (container) => {
    const isSelected = selectedContainer?.id === container.id;
    const isRunning = container.state === 'running';

    return (
      <div
        key={container.id}
        className={`container-item ${isSelected ? 'selected' : ''} ${container.state}`}
        onClick={() => onSelect(container)}
      >
        <div className="container-header">
          <span className={`status-dot ${container.state}`}></span>
          <span className="container-name">{container.name}</span>
        </div>

        <div className="container-meta">
          <span className="container-id">{container.id}</span>
          <span className="container-image" title={container.image}>
            {container.image.length > 30
              ? container.image.substring(0, 30) + '...'
              : container.image}
          </span>
        </div>

        <div className="container-stats">
          {isRunning ? (
            <>
              <div className="stat-row">
                <div className="stat-item">
                  <span className="stat-label">CPU</span>
                  <span className={`stat-value ${parseFloat(container.cpuPercent) > 80 ? 'high' : ''}`}>
                    {container.cpuPercent}%
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">RAM</span>
                  <span className={`stat-value ${parseFloat(container.memPercent) > 80 ? 'high' : ''}`}>
                    {formatBytes(container.memUsage)}
                  </span>
                </div>
              </div>
              <div className="stat-row">
                <div className="stat-item">
                  <span className="stat-label">Uptime</span>
                  <span className="stat-value">{formatUptime(container.created)}</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Size</span>
                  <span className="stat-value">{formatBytes(container.sizeRootFs)}</span>
                </div>
              </div>
            </>
          ) : (
            <div className="stat-row stopped-info">
              <span className="stopped-text">{container.status}</span>
            </div>
          )}
        </div>

        {container.ports && container.ports.length > 0 && (
          <div className="container-ports">
            {container.ports.slice(0, 3).map((port, idx) => (
              <span key={idx} className="port-badge">
                {port.PublicPort ? `${port.PublicPort}:${port.PrivatePort}` : port.PrivatePort}
              </span>
            ))}
            {container.ports.length > 3 && (
              <span className="port-badge more">+{container.ports.length - 3}</span>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="container-list">
      {runningContainers.length > 0 && (
        <div className="container-group">
          <div className="group-header">
            <span className="group-icon running">●</span>
            RUNNING ({runningContainers.length})
          </div>
          {runningContainers.map(renderContainer)}
        </div>
      )}

      {stoppedContainers.length > 0 && (
        <div className="container-group">
          <div className="group-header">
            <span className="group-icon stopped">●</span>
            STOPPED ({stoppedContainers.length})
          </div>
          {stoppedContainers.map(renderContainer)}
        </div>
      )}

      {containers.length === 0 && (
        <div className="no-containers">
          <p>No containers found</p>
          <p className="hint">Make sure Docker is running</p>
        </div>
      )}

      {containers.length > 0 && filteredContainers.length === 0 && (
        <div className="no-containers">
          <p>No matching containers</p>
          <p className="hint">Try a different search term</p>
        </div>
      )}
    </div>
  );
}

export default ContainerList;
