// Daily housekeeping for the router volume (omniroute_data). Runs in the
// router's own image, so it uses the same SQLite build and user (uid 1000).
//
//   node omniroute-maint.mjs           run every day at OMNIROUTE_MAINT_AT (UTC)
//   node omniroute-maint.mjs --once    run now, print one JSON line, exit 0
//   node omniroute-maint.mjs --health  exit 1 when no run has succeeded for 26 h
//
// Each step runs only while the router answers 200 on /healthz, which it does
// once its migrations have finished. A run:
//   1. keeps one copy in db_backups/, the database as it was before the last
//      router upgrade (the first, if there were several since the last run),
//      and removes snapshot temp dirs left by a crash;
//   2. trims request_cost_ledger and api_key_quota_counters, which have no
//      retention of their own, in short batches;
//   3. removes app log files untouched for a week, once the router logs to
//      stdout only.
// A run never exits non-zero. It counts as successful only if the router was
// ready for every step and every step completed. omniroute-maint.json on the
// volume records the router's migration version, the kept copy and the last
// successful run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const DATA_DIR = '/app/data';
const ROUTER_URL = 'http://omniroute:20128';
const STATE_FILE = 'omniroute-maint.json';
// Written once per container by the daemon, so a new container is healthy until
// an hour after its first run and a restart does not extend that.
const FIRST_RUN_FILE = '/tmp/omniroute-maint.first-run';

// The router gives up on a lock after 2 s (busy_timeout) and can crash if one
// of its own job writes hits that. 1000 rows hold the lock for about 10 ms.
const BATCH = 1000;
const PAUSE_MS = 200;
const BUSY_MS = 5000;
const MAX_RUN_MS = 10 * MIN;
// Manual and repair copies are written straight to their final name.
const BACKUPS_SETTLE_MS = 15 * MIN;
const TEMP_DIR_MIN_AGE_MS = HOUR;
const APP_LOG_KEEP_MS = 7 * DAY;
const HEALTHY_FOR_MS = 26 * HOUR;

const SELF = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const openDb = (file, options) => {
  const Database = require('/app/node_modules/better-sqlite3');
  return new Database(file, { fileMustExist: true, ...options });
};
const VERSION_SQL = 'SELECT max(CAST(version AS INTEGER)) AS v FROM _omniroute_migrations';

// Checked before the daemon starts, so a bad value shows as a restart loop.
export function readConfig(env = process.env) {
  const at = env.OMNIROUTE_MAINT_AT ?? '21:30';
  const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!hhmm) throw new Error(`OMNIROUTE_MAINT_AT must be HH:MM (UTC), got "${at}"`);
  const minute = Number(hhmm[1]) * 60 + Number(hhmm[2]);
  // The router's scheduled vacuum runs at 02:00 (its default vacuumHour; the
  // container clock is UTC).
  if (minute >= 105 && minute <= 150) {
    throw new Error(
      `OMNIROUTE_MAINT_AT ${at} is inside 01:45-02:30 UTC, next to the router's vacuum`,
    );
  }
  const number = (name, fallback) => {
    const raw = env[name] ?? fallback;
    if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${name} must be a number, got "${raw}"`);
    return Number(raw);
  };
  const ledgerDays = number('LEDGER_KEEP_DAYS', '45');
  const counterHours = number('COUNTER_KEEP_HOURS', '24');
  cutoffs(Date.now(), ledgerDays, counterHours);
  // The router writes app log files unless this is exactly 'false'.
  return { at, ledgerDays, counterHours, routerLogsToFile: env.APP_LOG_TO_FILE !== 'false' };
}

export function nextRunAt(at, fromMs) {
  const [h, m] = at.split(':').map(Number);
  const d = new Date(fromMs);
  let next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
  if (next <= fromMs) next += DAY;
  return next;
}

// The only ledger reader sums the current UTC month for one key; the only
// counter reader looks at the current and previous minute.
export function cutoffs(nowMs, ledgerDays, counterHours) {
  const d = new Date(nowMs);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const ledger = nowMs - ledgerDays * DAY;
  if (!(ledgerDays >= 32 && ledger < monthStart - DAY)) {
    throw new Error(`LEDGER_KEEP_DAYS=${ledgerDays} would reach into the current UTC month`);
  }
  if (!(counterHours * 60 >= 10)) {
    throw new Error(`COUNTER_KEEP_HOURS=${counterHours} is under 10 minutes`);
  }
  return { ledgerIso: new Date(ledger).toISOString(), counterMs: nowMs - counterHours * HOUR };
}

const isPreMigration = (name) => name.endsWith('_pre-migration.sqlite');
// A backup is X.sqlite plus its -wal/-shm/-journal files, as the router groups them.
const familyOf = (name) => name.replace(/-(wal|shm|journal)$/, '');

// The migration version a copy was taken at. Read only once the header shows a
// complete rollback-journal file (a WAL-mode copy may need a -wal file that is
// not there); a read-only open of such a file creates nothing next to it.
export function copyVersion(file) {
  try {
    const header = Buffer.alloc(100);
    const fd = fs.openSync(file, 'r');
    let size;
    try {
      fs.readSync(fd, header, 0, header.length, 0);
      size = fs.fstatSync(fd).size;
    } finally {
      fs.closeSync(fd);
    }
    if (header.toString('latin1', 0, 16) !== 'SQLite format 3\0') {
      return { unreadable: 'not a SQLite file' };
    }
    if (header[18] !== 1 || header[19] !== 1) return { unreadable: 'not in rollback-journal mode' };
    const pageSize = header.readUInt16BE(16) === 1 ? 65536 : header.readUInt16BE(16);
    // The header's page count is valid only while these two counters match.
    const countValid = header.readUInt32BE(24) === header.readUInt32BE(92);
    if (!countValid || header.readUInt32BE(28) * pageSize !== size) {
      return { unreadable: 'size does not match its header' };
    }
    const db = openDb(file, { readonly: true });
    try {
      const { v } = db.prepare(VERSION_SQL).get();
      return Number.isInteger(v) ? { version: v } : { unreadable: 'no migrations recorded' };
    } finally {
      db.close();
    }
  } catch (err) {
    return { unreadable: err.code || err.message };
  }
}

// Picks the copy to keep: the database as it was before the last router
// upgrade. Returns { keep }, or { hold } when nothing may be pruned (with
// fail set when that needs a look).
export function pickBackupToKeep(copies, live, state) {
  const usable = copies.filter((c) => isPreMigration(c.name) && Number.isInteger(c.version));
  const newestWhere = (test) =>
    usable.filter((c) => test(c.version)).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name;
  const firstRun = () => {
    // A fresh volume's first boot copies the empty schema (version 1). With no
    // record of the version before the last upgrade, two real copies may be a
    // clean one and a partly migrated one from a retried upgrade.
    const real = usable.filter((c) => c.version > 1 && c.version < live);
    if (real.length > 1) {
      return { hold: `several pre-upgrade copies (${real.length})`, fail: true };
    }
    const keep = real[0]?.name ?? newestWhere((v) => v < live);
    return keep ? { keep } : { hold: `no pre-upgrade copy below version ${live}` };
  };
  if (!Number.isInteger(state?.version)) return firstRun();
  if (live < state.version) {
    return { hold: `router version went down from ${state.version} to ${live}` };
  }
  if (live > state.version) {
    // Upgraded since the last run. The upgrade's first boot copied the database
    // at the version that run saw; a retry after a failed boot copies a partly
    // migrated one.
    const keep = newestWhere((v) => v === state.version);
    return keep ? { keep } : { hold: `no copy at version ${state.version}`, fail: true };
  }
  // After a restore or downgrade the recorded copy can be newer than the router
  // that now runs, so it only stays while it is older than the live database.
  const kept = usable.find((c) => c.name === state.kept && c.version < live);
  return kept ? { keep: kept.name } : firstRun();
}

function liveVersion(dbFile) {
  const db = openDb(dbFile, { timeout: BUSY_MS });
  try {
    const { v } = db.prepare(VERSION_SQL).get();
    if (!Number.isInteger(v)) throw new Error('no migrations recorded in storage.sqlite');
    return v;
  } finally {
    db.close();
  }
}

// Touches only db_* files and .migration-snapshot-* dirs in db_backups/.
// Returns the report plus the state to record, if any.
export function pruneBackups(dataDir, nowMs, state) {
  const dir = path.join(dataDir, 'db_backups');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.startsWith('db_'))
    .map((e) => ({ name: e.name, mtimeMs: fs.statSync(path.join(dir, e.name)).mtimeMs }));
  if (files.some((f) => nowMs - f.mtimeMs < BACKUPS_SETTLE_MS)) {
    return { skipped: 'a db_ file changed in the last 15 minutes' };
  }
  const live = liveVersion(path.join(dataDir, 'storage.sqlite'));
  const names = new Set(files.map((f) => f.name));
  const copies = files
    .filter((f) => f.name.endsWith('.sqlite'))
    .map((f) => {
      if (!isPreMigration(f.name)) return f;
      const sidecar = ['-wal', '-shm', '-journal'].some((s) => names.has(f.name + s));
      if (sidecar) return { ...f, unreadable: 'has -wal/-shm/-journal files' };
      return { ...f, ...copyVersion(path.join(dir, f.name)) };
    });
  const unreadable = copies.filter((c) => c.unreadable).map((c) => `${c.name}: ${c.unreadable}`);
  // Any of these may be the copy to keep, so nothing goes until they are sorted out by hand.
  if (unreadable.length) {
    return {
      liveVersion: live,
      unreadable,
      skipped: 'unreadable pre-upgrade copy; nothing pruned',
    };
  }
  const pick = pickBackupToKeep(copies, live, state);

  if (!pick.keep) {
    if (pick.fail) return { liveVersion: live, skipped: `${pick.hold}; nothing pruned` };
    return {
      liveVersion: live,
      held: `${pick.hold}; nothing pruned`,
      state: { version: live, kept: state?.kept ?? null },
    };
  }
  const deleted = [];
  for (const f of files) {
    if (familyOf(f.name) === pick.keep) continue;
    fs.rmSync(path.join(dir, f.name), { force: true });
    deleted.push(f.name);
  }
  // The router is ready, so no snapshot is being written; the age is a second guard.
  const removedTempDirs = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.migration-snapshot-')) continue;
    const p = path.join(dir, e.name);
    if (nowMs - fs.statSync(p).mtimeMs < TEMP_DIR_MIN_AGE_MS) continue;
    fs.rmSync(p, { recursive: true, force: true });
    removedTempDirs.push(e.name);
  }
  return {
    liveVersion: live,
    kept: pick.keep,
    deleted,
    removedTempDirs,
    state: { version: live, kept: pick.keep },
  };
}

const TABLES = [
  {
    table: 'request_cost_ledger',
    index: 'idx_rcl_timestamp',
    sample: 'SELECT timestamp AS v FROM request_cost_ledger ORDER BY id DESC LIMIT 1',
    looksRight: (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v),
    cutoff: (c) => c.ledgerIso, // the writer stores toISOString()
    del: `DELETE FROM request_cost_ledger WHERE id IN (
            SELECT id FROM request_cost_ledger WHERE timestamp < ? ORDER BY timestamp LIMIT ?)`,
  },
  {
    table: 'api_key_quota_counters',
    index: 'idx_akqc_updated_at',
    sample: 'SELECT updated_at AS v FROM api_key_quota_counters LIMIT 1',
    looksRight: (v) => Number.isInteger(v) && v > 1e12, // epoch milliseconds
    // Only the per-minute rpm/tpm windows are known to read these rows.
    other: `SELECT dimension_key AS v FROM api_key_quota_counters
              WHERE dimension_key NOT IN ('key-quota:rpm', 'key-quota:tpm') LIMIT 1`,
    cutoff: (c) => c.counterMs,
    del: `DELETE FROM api_key_quota_counters WHERE rowid IN (
            SELECT rowid FROM api_key_quota_counters WHERE updated_at < ? LIMIT ?)`,
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function trimTable(db, t, cutoff, { deadline, batch, pauseMs, ready }) {
  // Without its index each DELETE would scan the table while holding the lock.
  const indexed = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ? AND tbl_name = ?")
    .get(t.index, t.table);
  if (!indexed) return { skipped: 'table or index missing' };
  const sample = db.prepare(t.sample).get();
  if (sample && !t.looksRight(sample.v)) return { skipped: 'unexpected timestamp format' };
  const other = t.other && db.prepare(t.other).get();
  if (other) return { skipped: `unexpected dimension_key ${JSON.stringify(other.v)}` };

  const del = db.prepare(t.del);
  const r = { deleted: 0, batches: 0, maxBatchMs: 0 };
  try {
    for (;;) {
      if (Date.now() >= deadline) {
        r.stoppedAtCap = true;
        break;
      }
      const t0 = performance.now();
      const { changes } = del.run(cutoff, batch);
      r.maxBatchMs = Math.max(r.maxBatchMs, Math.round(performance.now() - t0));
      r.deleted += changes;
      r.batches += 1;
      if (changes < batch) break;
      await sleep(pauseMs);
      // The router may start stopping or upgrading mid-table.
      const gate = await ready();
      if (gate !== true) {
        r.skipped = gate;
        break;
      }
    }
  } catch (err) {
    r.error = err.code || err.message; // SQLITE_BUSY etc.: stop, retry tomorrow
  }
  return r;
}

export async function trimTables(dbFile, cut, opts = {}) {
  const {
    busyMs = BUSY_MS,
    deadline = Date.now() + MAX_RUN_MS,
    batch = BATCH,
    pauseMs = PAUSE_MS,
    ready = async () => true,
  } = opts;
  // Autocommit statements only: never a long transaction, VACUUM or a
  // TRUNCATE/RESTART checkpoint against the live router.
  const db = openDb(dbFile, { timeout: busyMs });
  try {
    const out = {};
    for (const [i, t] of TABLES.entries()) {
      const gate = await ready();
      if (gate !== true) {
        out[t.table] = { skipped: gate };
        return out;
      }
      // An equal share of the time left, so one table's backlog cannot starve the other.
      const share = Date.now() + (deadline - Date.now()) / (TABLES.length - i);
      out[t.table] = await trimTable(db, t, t.cutoff(cut), {
        deadline: share,
        batch,
        pauseMs,
        ready,
      });
    }
    out.autoVacuum = db.pragma('auto_vacuum', { simple: true });
    out.freelistPages = db.pragma('freelist_count', { simple: true });
    return out;
  } finally {
    db.close();
  }
}

export function pruneAppLogs(dir, nowMs, routerLogsToFile) {
  // The router keeps its current file open; old files are leftovers only once
  // it logs to stdout.
  if (routerLogsToFile) return { held: 'router logs to file' };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { deleted: [] };
    throw err;
  }
  const deleted = [];
  for (const name of names) {
    if (!/^app(\..+)?\.log$/.test(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (!st.isFile() || nowMs - st.mtimeMs < APP_LOG_KEEP_MS) continue;
    fs.rmSync(p, { force: true });
    deleted.push(name);
  }
  return { deleted };
}

async function routerReady(url) {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
    return res.status === 200 ? true : `router not ready (${res.status})`;
  } catch (err) {
    return `router unreachable (${err.cause?.code || err.name})`;
  }
}

function readState(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  // A damaged record counts as none: the first-run rule is as safe, and the next
  // write replaces it.
  try {
    const state = JSON.parse(text);
    return state && typeof state === 'object' && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

function writeState(file, state) {
  // Per process, so a manual --once next to a scheduled run cannot clobber it.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  fs.renameSync(tmp, file);
}

const attempt = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    return { error: [err.code, err.message].filter(Boolean).join(' ') };
  }
};

const failed = (r) => !r || 'error' in r || 'skipped' in r || r.stoppedAtCap === true;
const succeeded = (r) =>
  !r.skipped &&
  !failed(r.backups) &&
  !failed(r.tables) &&
  !failed(r.tables.request_cost_ledger) &&
  !failed(r.tables.api_key_quota_counters) &&
  !failed(r.appLogs);

const sizeOf = (p) => {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
};

export async function runOnce(opts = {}) {
  const {
    dataDir = DATA_DIR,
    routerUrl = ROUTER_URL,
    now = Date.now(),
    ledgerDays = 45,
    counterHours = 24,
    routerLogsToFile = true,
    maxRunMs = MAX_RUN_MS,
    ...trimOpts
  } = opts;
  const report = { at: new Date(now).toISOString() };
  const ready = () => routerReady(routerUrl);
  const stateFile = path.join(dataDir, STATE_FILE);
  const dbFile = path.join(dataDir, 'storage.sqlite');
  const deadline = Date.now() + maxRunMs;
  const steps = {
    // Backups first: deleting files frees disk even when the database is busy.
    backups: () => {
      const state = readState(stateFile);
      const { state: next, ...result } = pruneBackups(dataDir, now, state);
      if (state === null && fs.existsSync(stateFile)) result.stateIgnored = 'unreadable';
      if (next) writeState(stateFile, { ...state, ...next });
      return result;
    },
    tables: () =>
      trimTables(dbFile, cutoffs(now, ledgerDays, counterHours), { ...trimOpts, deadline, ready }),
    appLogs: () => pruneAppLogs(path.join(dataDir, 'logs', 'application'), now, routerLogsToFile),
  };
  for (const [name, step] of Object.entries(steps)) {
    const gate = await ready();
    if (gate !== true) {
      report.skipped = gate;
      break;
    }
    report[name] = await attempt(step);
  }
  if (!report.backups) return { ...report, ok: false };

  report.ok = succeeded(report);
  if (report.ok) {
    const saved = await attempt(() =>
      writeState(stateFile, { ...readState(stateFile), lastSuccessAt: report.at }),
    );
    if (saved?.error) report.ok = false;
  }
  let backupBytes = 0;
  try {
    for (const name of fs.readdirSync(path.join(dataDir, 'db_backups'))) {
      backupBytes += sizeOf(path.join(dataDir, 'db_backups', name)) || 0;
    }
  } catch {
    backupBytes = null;
  }
  report.bytes = { db: sizeOf(dbFile), wal: sizeOf(`${dbFile}-wal`), backups: backupBytes };
  return report;
}

// Healthy after a successful run in the last 26 h, or until an hour after a
// fresh daemon's first run.
export function health(dataDir, nowMs, firstRunFile = FIRST_RUN_FILE) {
  const read = (fn) => {
    try {
      return fn() || 0;
    } catch {
      return 0;
    }
  };
  const last = read(() => Date.parse(readState(path.join(dataDir, STATE_FILE)).lastSuccessAt));
  const firstRun = read(() => Number(fs.readFileSync(firstRunFile, 'utf8')));
  return {
    healthy: nowMs - last <= HEALTHY_FOR_MS || nowMs <= firstRun + HOUR,
    lastSuccessAt: last ? new Date(last).toISOString() : null,
    firstRunAt: firstRun ? new Date(firstRun).toISOString() : null,
  };
}

export function markFirstRun(file, runAtMs) {
  try {
    fs.writeFileSync(file, String(runAtMs), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

function daemon(config) {
  let child = null;
  let timer = null;
  let lastStart = 0;
  const stop = () => {
    clearTimeout(timer);
    if (child) child.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const schedule = () => {
    // Each run is a fresh process, so an updated script applies from the next run.
    const at = nextRunAt(config.at, Math.max(Date.now(), lastStart + MIN));
    console.log(JSON.stringify({ nextRunAt: new Date(at).toISOString() }));
    timer = setTimeout(() => {
      lastStart = Date.now();
      child = spawn(process.execPath, [SELF, '--once'], { stdio: 'inherit' });
      // Backstop for the cap inside a run; every batch is its own commit.
      const kill = setTimeout(() => child?.kill('SIGKILL'), MAX_RUN_MS + 5 * MIN);
      child.on('error', (err) => console.log(JSON.stringify({ error: String(err) })));
      child.on('close', () => {
        clearTimeout(kill);
        child = null;
        schedule();
      });
    }, at - Date.now());
  };
  markFirstRun(FIRST_RUN_FILE, nextRunAt(config.at, Date.now()));
  console.log(JSON.stringify({ started: config }));
  schedule();
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const mode = process.argv[2];
  if (mode === '--health') {
    const h = health(DATA_DIR, Date.now());
    console.log(JSON.stringify(h));
    process.exit(h.healthy ? 0 : 1);
  } else if (mode === '--once') {
    Promise.resolve()
      .then(() => {
        const { at, ...settings } = readConfig();
        return runOnce(settings);
      })
      .catch((err) => ({ error: err.message }))
      .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0)));
  } else {
    let config;
    try {
      config = readConfig();
    } catch (err) {
      console.error(JSON.stringify({ error: err.message }));
      process.exit(1);
    }
    daemon(config);
  }
}
