const fs = require('fs');
const path = require('path');

function createUserStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // A missing file means a fresh install. A corrupt one must not be treated
  // as empty: that would re-run the admin bootstrap and overwrite real data.
  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return { users: [] };
      throw error;
    }
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.users)) {
      throw new Error(`${file} does not contain a "users" array`);
    }
    return data;
  }

  // Write to a temp file and rename so a crash never leaves a half-written file
  function save(data) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  return { file, load, save };
}

module.exports = { createUserStore };
