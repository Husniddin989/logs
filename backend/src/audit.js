const fs = require('fs');
const path = require('path');

const MAX_FIELD_LENGTH = 200;

// Strings are truncated so a client cannot flood the log through a header or
// a username field. JSON encoding escapes newlines, so entries cannot be
// forged by injecting line breaks.
function sanitize(value) {
  if (typeof value === 'string') {
    return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, sanitize(v)])
    );
  }
  return value;
}

// Security events as one JSON object per line, tagged "type":"audit". They go
// to stdout (docker logs) and, when configured, are appended to a file in the
// data volume so they survive container re-creation. Callers must never pass
// passwords, hashes or tokens.
function createAuditLogger({ file = null, stream = process.stdout, now = () => new Date() } = {}) {
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });

  function log(event, fields = {}) {
    const entry = { ts: now().toISOString(), type: 'audit', event, ...sanitize(fields) };
    const line = `${JSON.stringify(entry)}\n`;
    stream.write(line);
    if (file) {
      try {
        // appendFileSync reopens the file each time, so external log
        // rotation (rename or copytruncate) keeps working
        fs.appendFileSync(file, line, { mode: 0o600 });
      } catch (error) {
        console.error(`[audit] could not write ${file}: ${error.message}`);
      }
    }
    return entry;
  }

  return { log };
}

module.exports = { createAuditLogger };
