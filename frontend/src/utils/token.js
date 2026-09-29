// Reads the expiry of a JWT without verifying it (the server does that).
// Returns milliseconds since epoch, or 0 when the token is unreadable.
export function tokenExpiresAt(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(payload));
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}
