// Docker accepts a full ID, a name or a unique ID prefix as a container
// reference. Anything outside this pattern (slashes, dots-only, encoded path
// segments) is rejected before it reaches the Docker API.
const CONTAINER_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const ID_PREFIX_PATTERN = /^[a-f0-9]{12,64}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;
const ROLES = ['admin', 'user'];

function isValidContainerRef(ref) {
  return typeof ref === 'string' && CONTAINER_REF_PATTERN.test(ref);
}

// Access is decided on the container's canonical identity as reported by
// Docker ({ id: full ID, name }), never on the string a client sent. An
// allowedContainers entry matches the exact name, the exact full ID, or the
// start of the full ID when the entry itself is a hex ID of 12+ characters.
// The "*" wildcard is honoured for nobody: admins do not need it and regular
// users must be granted containers explicitly.
function canAccessContainer(user, container) {
  if (!user || !container) return false;
  if (user.role === 'admin') return true;

  const allowed = Array.isArray(user.allowedContainers) ? user.allowedContainers : [];
  return allowed.some(entry => {
    if (typeof entry !== 'string' || !entry) return false;
    if (entry === container.name || entry === container.id) return true;
    return ID_PREFIX_PATTERN.test(entry) && container.id.startsWith(entry);
  });
}

// Validates an allowedContainers payload. Returns { value } or { error }.
function normalizeAllowedContainers(value, role) {
  if (value === undefined) return { value: undefined };
  if (!Array.isArray(value)) return { error: 'allowedContainers must be an array' };

  const cleaned = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return { error: 'allowedContainers entries must be strings' };
    const ref = entry.trim().replace(/^\//, '');
    if (ref === '*') {
      if (role !== 'admin') {
        return { error: 'The "*" wildcard is reserved for admins; select containers explicitly' };
      }
      continue;
    }
    if (!isValidContainerRef(ref)) return { error: `Invalid container reference: ${entry}` };
    if (!cleaned.includes(ref)) cleaned.push(ref);
  }
  return { value: role === 'admin' ? [] : cleaned };
}

function validateUsername(username) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    return 'Username must be 1-64 characters: letters, digits, ".", "_", "@" or "-"';
  }
  return null;
}

function validateRole(role) {
  return ROLES.includes(role) ? null : `Role must be one of: ${ROLES.join(', ')}`;
}

module.exports = {
  isValidContainerRef,
  canAccessContainer,
  normalizeAllowedContainers,
  validateUsername,
  validateRole
};
