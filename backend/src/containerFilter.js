// Which containers alerts leave out: names and name patterns from the
// settings, and CI job containers that come and go with every pipeline.

// "runner-*" style patterns: letters, digits, _ . - and the * wildcard
const PATTERN = /^[A-Za-z0-9_.*-]{1,128}$/;

// GitLab Runner's docker executor labels every job container it creates
// (build, service and helper containers), and names them
// runner-<token>-project-<id>-concurrent-<n>-...
const GITLAB_RUNNER_LABEL_PREFIX = 'com.gitlab.gitlab-runner.';
const GITLAB_RUNNER_NAME = /^runner-[A-Za-z0-9_]+-project-\d+-concurrent-\d+/;

function isPattern(entry) {
  return typeof entry === 'string' && entry.includes('*');
}

function isValidPattern(entry) {
  return isPattern(entry) && PATTERN.test(entry);
}

function patternToRegExp(pattern) {
  // Only * is special; everything else (also from env values) is literal
  const source = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\-]/g, '\\$&')).join('.*');
  return new RegExp(`^${source}$`);
}

// The runner's own long-lived container (e.g. "gitlab-runner") carries no
// such label and is still watched.
function isCiRunnerContainer(container) {
  const labels = container.labels || {};
  return Object.keys(labels).some(key => key.startsWith(GITLAB_RUNNER_LABEL_PREFIX)) ||
    GITLAB_RUNNER_NAME.test(container.name || '');
}

// Returns container => true when the container must be left out of alerts
function createContainerFilter({ ignoreContainers = [], ignoreCiRunners = true } = {}) {
  const names = new Set(ignoreContainers.filter(entry => !isPattern(entry)));
  const patterns = ignoreContainers.filter(isPattern).map(patternToRegExp);
  return container => names.has(container.name) ||
    patterns.some(pattern => pattern.test(container.name)) ||
    (ignoreCiRunners && isCiRunnerContainer(container));
}

module.exports = { createContainerFilter, isCiRunnerContainer, isPattern, isValidPattern, patternToRegExp };
