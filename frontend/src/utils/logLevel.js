// Shared log-level detection used by both the viewer and the level filter,
// so a log is always classified the same way everywhere.
export function getLogLevel(log) {
  const msg = log.message.toLowerCase();
  if (log.stream === 'stderr' || /\b(error|err|fatal|panic|critical)\b/.test(msg)) {
    return 'error';
  }
  if (/\b(warn|warning)\b/.test(msg)) {
    return 'warn';
  }
  if (/\b(debug|trace)\b/.test(msg)) {
    return 'debug';
  }
  if (/\binfo\b/.test(msg)) {
    return 'info';
  }
  return 'default';
}
