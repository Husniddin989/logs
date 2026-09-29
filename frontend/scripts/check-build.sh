#!/bin/sh
# Fails when a production build would expose the original source code or
# ship something that looks like a credential. Everything in the build
# directory is public.
set -eu

BUILD_DIR="${1:-build}"
status=0

maps=$(find "$BUILD_DIR" -type f -name '*.map')
if [ -n "$maps" ]; then
  echo "ERROR: source maps found in $BUILD_DIR:" >&2
  echo "$maps" >&2
  status=1
fi

refs=$(find "$BUILD_DIR" -type f \( -name '*.js' -o -name '*.css' \) -exec grep -l 'sourceMappingURL=' {} + || true)
if [ -n "$refs" ]; then
  echo "ERROR: sourceMappingURL references found in:" >&2
  echo "$refs" >&2
  status=1
fi

# Every REACT_APP_* variable is compiled into the bundle, so none of them may
# carry a secret.
secret_vars=$(env | grep -E '^REACT_APP_[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_KEY|APIKEY)[A-Z0-9_]*=' | cut -d= -f1 || true)
if [ -n "$secret_vars" ]; then
  echo "ERROR: secret-looking REACT_APP_* variables are set at build time (they end up in the public bundle):" >&2
  echo "$secret_vars" >&2
  status=1
fi

# Credential patterns: private keys, AWS/GitHub/Slack/Stripe keys, JWTs,
# bcrypt hashes and the names of the backend's secret settings.
SECRET_PATTERN='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|xox[abprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}|\$2[aby]\$[0-9]{2}\$|JWT_SECRET|ADMIN_INITIAL_PASSWORD'
leaks=$(grep -rlE -- "$SECRET_PATTERN" "$BUILD_DIR" || true)
if [ -n "$leaks" ]; then
  echo "ERROR: credential-like content found in:" >&2
  echo "$leaks" >&2
  grep -rhoE -- "$SECRET_PATTERN" "$BUILD_DIR" | cut -c1-24 | sed 's/$/.../' | sort -u >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "Build check passed: no source maps or credential-like content in $BUILD_DIR"
fi
exit "$status"
