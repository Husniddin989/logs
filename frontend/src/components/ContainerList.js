import React from 'react';
import './ContainerList.css';

function ContainerList({ containers, selectedContainer, onSelect }) {
  const runningContainers = containers.filter(c => c.state === 'running');
  const stoppedContainers = containers.filter(c => c.state !== 'running');

  const renderContainer = (container) => {
    const isSelected = selectedContainer?.id === container.id;

    return (
      <div
        key={container.id}
        className={`container-item ${isSelected ? 'selected' : ''} ${container.state}`}
        onClick={() => onSelect(container)}
      >
        <div className="container-main">
          <span className={`status-dot ${container.state}`}></span>
          <span className="container-name">{container.name}</span>
        </div>
        <div className="container-details">
          <span className="container-id">{container.id}</span>
          <span className="container-image" title={container.image}>
            {container.image.length > 25
              ? container.image.substring(0, 25) + '...'
              : container.image}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="container-list">
      {runningContainers.length > 0 && (
        <div className="container-group">
          <div className="group-header">
            <span className="group-icon running">●</span>
            Running ({runningContainers.length})
          </div>
          {runningContainers.map(renderContainer)}
        </div>
      )}

      {stoppedContainers.length > 0 && (
        <div className="container-group">
          <div className="group-header">
            <span className="group-icon stopped">●</span>
            Stopped ({stoppedContainers.length})
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
    </div>
  );
}

export default ContainerList;
