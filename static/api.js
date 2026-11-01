'use strict';
/* Hostel Desk (static build) - the server, running in the browser.
 *
 * A JavaScript port of HostelServer.java. Same /api routes, same JSON, same
 * validation and error messages, but the database is SQLite (sql.js) and is
 * kept in this browser's IndexedDB instead of Oracle.
 *
 *   HostelAPI.request(method, '/students?page=2', body) -> { ok, status, data }
 */
const HostelAPI = (() => {

  // ============================================================ config / state
  const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
  const SESSION_KEY = 'hd-session';
  const IDB_NAME = 'hostel-desk', IDB_STORE = 'files', IDB_KEY = 'hostel.db';
  const TODAY = "date('now', 'localtime')", NOW = "datetime('now', 'localtime')";
  const TABLES = new Map();
  const failures = new Map();                 // user -> {count, first}
  let SQL = null, db = null, dirty = false;
  let storage = 'indexeddb';                  // or 'memory' when IndexedDB is blocked
  let memorySession = null;

  class ApiException extends Error {
    constructor(status, msg) { super(msg); this.status = status; }
  }
  const bad = m => new ApiException(400, m);

  // ============================================================ IndexedDB persistence
  function idb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB is not available'));
      const rq = indexedDB.open(IDB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(IDB_STORE);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
      rq.onblocked = () => reject(new Error('IndexedDB is blocked'));
    });
  }
  async function idbDo(mode, fn) {
    const conn = await idb();
    try {
      return await new Promise((resolve, reject) => {
        const tr = conn.transaction(IDB_STORE, mode);
        const rq = fn(tr.objectStore(IDB_STORE));
        tr.oncomplete = () => resolve(rq.result);
        tr.onerror = tr.onabort = () => reject(tr.error || rq.error);
      });
    } finally { conn.close(); }
  }
  const loadSaved = () => idbDo('readonly', s => s.get(IDB_KEY));
  let saving = Promise.resolve();
  function save() {
    dirty = false;
    const bytes = db.export();
    afterOpen();                              // export() closes and reopens the database
    if (storage !== 'indexeddb') return saving;
    saving = saving.then(() => idbDo('readwrite', s => s.put(bytes, IDB_KEY))).catch(e => {
      console.warn('Hostel Desk: could not save to IndexedDB, keeping data in memory only.', e);
      storage = 'memory';
    });
    return saving;
  }

  // ============================================================ open / reset
  function afterOpen() {
    db.exec('PRAGMA foreign_keys = ON');
  }
  async function freshDb() {
    const res = await fetch('schema.sql', { cache: 'no-cache' });
    if (!res.ok) throw new Error('schema.sql could not be loaded (' + res.status + ')');
    const sql = await res.text();
    if (db) db.close();
    db = new SQL.Database();
    db.exec(sql);
    afterOpen();
  }
  function looksValid(d) {
    try {
      const r = d.exec("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('ROOM', 'STUDENT', 'FEE', 'APP_USER', 'AUDIT_LOG')");
      return r[0].values[0][0] === 5;
    } catch (e) { return false; }
  }
  async function init() {
    if (typeof initSqlJs !== 'function') throw new Error('sql-wasm.js did not load');
    SQL = await initSqlJs({ locateFile: f => f });
    let bytes = null;
    try { bytes = await loadSaved(); }
    catch (e) { console.warn('Hostel Desk: IndexedDB unavailable, data will last only until this tab is closed.', e); storage = 'memory'; }
    if (bytes) {
      try {
        const d = new SQL.Database(new Uint8Array(bytes));
        if (looksValid(d)) { db = d; afterOpen(); } else d.close();
      } catch (e) { console.warn('Hostel Desk: saved database is unreadable, starting from the sample data.', e); }
    }
    if (!db) { await freshDb(); dirty = true; }
    await ensureAdmin();
    if (dirty) await save();
  }
  const ready = init();

  async function reset() {
    await ready;
    await freshDb();
    await ensureAdmin();
    await save();
  }

  // ============================================================ SQL helpers
  function prep(sql, p) {
    const st = db.prepare(sql);
    if (p && p.length) st.bind(p.map(v => v === undefined ? null : v));
    return st;
  }
  function rows(sql, ...p) {
    const st = prep(sql, p);
    try {
      const out = [], cols = st.getColumnNames().map(c => c.toLowerCase());
      while (st.step()) {
        const v = st.get(), row = {};
        cols.forEach((c, i) => { if (c !== 'rn__') row[c] = v[i]; });
        out.push(row);
      }
      return out;
    } finally { st.free(); }
  }
  /** rows as plain arrays (used by reports, column labels do not matter) */
  function grid(sql, ...p) {
    const st = prep(sql, p);
    try { const out = []; while (st.step()) out.push(st.get()); return out; }
    finally { st.free(); }
  }
  function one(sql, ...p) { const r = rows(sql, ...p); return r.length ? r[0] : null; }
  function num(sql, ...p) { const g = grid(sql, ...p); return g.length && g[0][0] != null ? Number(g[0][0]) : 0; }
  function exec(sql, ...p) {
    const st = prep(sql, p);
    try { st.step(); } finally { st.free(); }
    const n = db.getRowsModified();
    if (n > 0) dirty = true;
    return n;
  }
  /** runs the work as one transaction (commit on success, rollback on any error) */
  function tx(work) {
    db.exec('BEGIN');
    try { const r = work(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (ignore) { /* already rolled back */ } throw e; }
  }
  const money2 = n => Math.round(Number(n) * 100) / 100;

  function audit(user, action, table, detail) {
    if (detail != null && detail.length > 290) detail = detail.substring(0, 290);
    exec('INSERT INTO AUDIT_LOG (USERNAME, ACTION, TABLE_NAME, DETAIL, LOG_TIME) VALUES (?, ?, ?, ?, ' + NOW + ')', user, action, table, detail);
  }

  /** SQLite error -> the same friendly messages the Java server gives for Oracle errors */
  function friendly(e, op) {
    const m = String(e && e.message || e), mu = m.toUpperCase();
    if (mu.includes('UNIQUE CONSTRAINT FAILED')) return 'A record with the same unique value already exists.';
    if (mu.includes('CHECK CONSTRAINT FAILED')) {
      if (mu.includes('CHK_OCC')) return 'Occupied beds cannot be more than the room capacity.';
      if (mu.includes('CHK_LEAVE')) return 'Leave end date cannot be before the start date.';
      if (mu.includes('LENGTH(')) return 'A value is too long for its field.';
      return 'A value is outside the allowed range.';
    }
    if (mu.includes('FOREIGN KEY CONSTRAINT FAILED'))
      return op === 'DELETE' ? 'This record is still used by other records, so it cannot be deleted.' : 'The selected related record does not exist.';
    if (mu.includes('NOT NULL CONSTRAINT FAILED')) return 'A required value is missing.';
    if (mu.includes('NO SUCH TABLE')) return 'Table not found. Use "Reset to sample data" from the account menu.';
    const first = m.split('\n')[0];
    return first.length > 200 ? first.substring(0, 200) : first;
  }
  const isSqlError = e => e && !(e instanceof ApiException) && /constraint|SQLITE|no such|syntax error/i.test(String(e.message));

  // ============================================================ small helpers
  const map = (...kv) => { const m = {}; for (let i = 0; i < kv.length; i += 2) m[kv[i]] = kv[i + 1]; return m; };
  function text(b, k) {
    const v = b[k];
    return v == null ? '' : String(v).trim();
  }
  const raw = (b, k) => b[k] == null ? '' : String(b[k]);
  function idOf(s) {
    if (!/^[+-]?\d{1,18}$/.test(s)) throw bad('Invalid id.');
    return Number(s);
  }
  const full = (re, s) => new RegExp('^(?:' + re + ')$').test(s);
  function isDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const escLike = s => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

  // ============================================================ passwords (Web Crypto, same PBKDF2 as the Java server)
  const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
  function subtle() {
    if (!window.crypto || !crypto.subtle) throw new ApiException(500, 'This page must be opened over https (or localhost) so the browser can hash passwords.');
    return crypto.subtle;
  }
  function newSalt() { const b = new Uint8Array(16); crypto.getRandomValues(b); return hex(b); }
  async function hashPw(pw, salt) {
    const key = await subtle().importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: 65536 }, key, 256);
    return hex(new Uint8Array(bits));
  }
  function sameHash(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return d === 0;
  }

  async function ensureAdmin() {
    if (num('SELECT COUNT(*) FROM APP_USER') === 0) {
      const salt = newSalt(), h = await hashPw('admin123', salt);
      exec('INSERT INTO APP_USER (USERNAME, PASSWORD_HASH, SALT, ROLE, CREATED_ON) VALUES (?, ?, ?, \'ADMIN\', ' + NOW + ')', 'admin', h, salt);
    }
  }

  // ============================================================ session (this tab only; cosmetic)
  function readSession() {
    try { const s = sessionStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; }
    catch (e) { return memorySession; }
  }
  function writeSession(s) {
    memorySession = s;
    try { if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); else sessionStorage.removeItem(SESSION_KEY); }
    catch (e) { /* storage blocked: memorySession is used */ }
  }
  function sessionOf() {
    const s = readSession();
    if (!s || !s.user) return null;
    const now = Date.now();
    if (now - s.last > SESSION_IDLE_MS) { writeSession(null); return null; }
    const u = one('SELECT USERNAME, ROLE FROM APP_USER WHERE USERNAME = ?', s.user);   // deleted users / changed roles apply at once
    if (!u) { writeSession(null); return null; }
    s.last = now;
    writeSession(s);
    return { user: u.username, role: u.role };
  }

  async function login(r) {
    const b = r.body;
    const user = text(b, 'username'), pw = raw(b, 'password');
    if (!user || !pw) throw bad('Enter your username and password.');
    const key = user.toLowerCase(), now = Date.now();
    let f = failures.get(key);
    if (f && now - f.first > 5 * 60 * 1000) { failures.delete(key); f = null; }
    if (f && f.count >= 5) throw new ApiException(429, 'Too many failed attempts. Try again in a few minutes.');

    const u = one('SELECT USERNAME, PASSWORD_HASH, SALT, ROLE FROM APP_USER WHERE UPPER(USERNAME) = UPPER(?)', user);
    let ok = false;
    if (u) ok = sameHash(await hashPw(pw, u.salt), u.password_hash);
    else await hashPw(pw, newSalt());                       // keep timing similar
    if (!ok) {
      if (!failures.has(key)) failures.set(key, { count: 0, first: now });
      failures.get(key).count++;
      throw new ApiException(401, 'Wrong username or password.');
    }
    failures.delete(key);
    writeSession({ user: u.username, last: Date.now() });
    exec('UPDATE APP_USER SET LAST_LOGIN = ' + NOW + ' WHERE USERNAME = ?', u.username);
    return map('username', u.username, 'role', u.role);
  }

  async function changePassword(r) {
    const b = r.body;
    const oldPw = raw(b, 'old_password'), newPw = raw(b, 'new_password');
    if (newPw.length < 6) throw bad('New password must be at least 6 characters.');
    const user = r.s.user;
    const u = one('SELECT PASSWORD_HASH, SALT FROM APP_USER WHERE USERNAME = ?', user);
    if (!u) throw new ApiException(404, 'User not found.');
    if (!sameHash(await hashPw(oldPw, u.salt), u.password_hash)) throw bad('Current password is wrong.');
    const salt = newSalt(), h = await hashPw(newPw, salt);
    return tx(() => {
      exec('UPDATE APP_USER SET PASSWORD_HASH = ?, SALT = ? WHERE USERNAME = ?', h, salt, user);
      audit(user, 'PASSWORD', 'APP_USER', 'changed own password');
      return map('ok', true);
    });
  }

  async function users(r) {
    const m = r.method;
    const target = r.seg.length > 2 ? r.seg[2] : null;
    const me = r.s.user;
    if (m === 'GET') {
      return map('rows', rows("SELECT USERNAME, ROLE, strftime('%Y-%m-%d', CREATED_ON) AS CREATED_ON, strftime('%Y-%m-%d %H:%M', LAST_LOGIN) AS LAST_LOGIN FROM APP_USER ORDER BY USERNAME"));
    }
    const b = r.body;
    if (m === 'POST') {
      const u = text(b, 'username'), role = text(b, 'role').toUpperCase(), pw = raw(b, 'password');
      if (!full('[A-Za-z0-9_.-]{3,30}', u)) throw bad('Username must be 3-30 letters, digits, dot, dash or underscore.');
      if (pw.length < 6) throw bad('Password must be at least 6 characters.');
      if (role !== 'ADMIN' && role !== 'VIEWER') throw bad('Role must be ADMIN or VIEWER.');
      const salt = newSalt(), h = await hashPw(pw, salt);
      return tx(() => {
        if (num('SELECT COUNT(*) FROM APP_USER WHERE UPPER(USERNAME) = UPPER(?)', u) > 0) throw bad('That username is taken.');
        exec('INSERT INTO APP_USER (USERNAME, PASSWORD_HASH, SALT, ROLE, CREATED_ON) VALUES (?, ?, ?, ?, ' + NOW + ')', u, h, salt, role);
        audit(me, 'CREATE', 'APP_USER', u + ' (' + role + ')');
        return map('ok', true);
      });
    }
    if (target == null) throw bad('Missing username.');
    if (m === 'PUT') {
      const role = text(b, 'role').toUpperCase(), pw = raw(b, 'password');
      let salt = null, h = null;
      if (pw && pw.length >= 6) { salt = newSalt(); h = await hashPw(pw, salt); }
      return tx(() => {
        if (num('SELECT COUNT(*) FROM APP_USER WHERE USERNAME = ?', target) === 0) throw new ApiException(404, 'User not found.');
        if (role) {
          if (role !== 'ADMIN' && role !== 'VIEWER') throw bad('Role must be ADMIN or VIEWER.');
          if (role === 'VIEWER' && num("SELECT COUNT(*) FROM APP_USER WHERE ROLE = 'ADMIN' AND USERNAME <> ?", target) === 0)
            throw bad('There must be at least one admin.');
          exec('UPDATE APP_USER SET ROLE = ? WHERE USERNAME = ?', role, target);
        }
        if (pw) {
          if (pw.length < 6) throw bad('Password must be at least 6 characters.');
          exec('UPDATE APP_USER SET PASSWORD_HASH = ?, SALT = ? WHERE USERNAME = ?', h, salt, target);
        }
        audit(me, 'UPDATE', 'APP_USER', target + (role ? ' role=' + role : '') + (pw ? ' password reset' : ''));
        return map('ok', true);
      });
    }
    if (m === 'DELETE') {
      if (target.toLowerCase() === me.toLowerCase()) throw bad('You cannot delete your own account.');
      return tx(() => {
        if (num("SELECT COUNT(*) FROM APP_USER WHERE ROLE = 'ADMIN' AND USERNAME <> ?", target) === 0
          && num("SELECT COUNT(*) FROM APP_USER WHERE ROLE = 'ADMIN' AND USERNAME = ?", target) > 0)
          throw bad('There must be at least one admin.');
        const n = exec('DELETE FROM APP_USER WHERE USERNAME = ?', target);
        if (n === 0) throw new ApiException(404, 'User not found.');
        audit(me, 'DELETE', 'APP_USER', target);
        return map('ok', true);
      });
    }
    throw new ApiException(405, 'Method not allowed.');
  }

  // ============================================================ table definitions
  class Field {
    constructor(key, label, type, sql) {
      Object.assign(this, { key, label, type, sql, col: null, required: false, list: true, form: true, createOnly: false,
        filter: false, range: false, autoUser: false, min: null, max: null, maxLen: null, pattern: null, patternHint: null,
        defaultSql: null, ref: null, help: null, options: null });
    }
    c(col) { this.col = col; return this; }
    req() { this.required = true; return this; }
    opts(...o) { this.options = o; return this; }
    refTo(r) { this.ref = r; return this; }
    mn(v) { this.min = v; return this; }
    mx(v) { this.max = v; return this; }
    len(n) { this.maxLen = n; return this; }
    pat(p, hint) { this.pattern = p; this.patternHint = hint; return this; }
    noList() { this.list = false; return this; }
    noForm() { this.form = false; return this; }
    def(s) { this.defaultSql = s; return this; }
    auto() { this.autoUser = true; this.form = false; return this; }
    filt() { this.filter = true; return this; }
    rng() { this.range = true; return this; }
    createOnlyF() { this.createOnly = true; return this; }
    hlp(h) { this.help = h; return this; }
    selectExpr() {
      if (this.type === 'date') return "strftime('%Y-%m-%d', " + this.sql + ')';
      if (this.type === 'datetime') return "strftime('%Y-%m-%d %H:%M', " + this.sql + ')';
      return this.sql;
    }
  }
  class TableDef {
    constructor(key, title, dbName, from, pk, pkSql, auto) {
      Object.assign(this, { key, title, dbName, from, pk, pkSql, auto, defaultSort: pk, defaultDir: 'asc',
        readOnly: false, adminOnly: false, fields: [], search: [], flags: new Map(), check: null, beforeDelete: null });
    }
    pkCol() { return this.pk.toUpperCase(); }
    add(f) { this.fields.push(f); return f; }
    field(k) { return this.fields.find(f => f.key === k) || null; }
    flag(k, label, cond) { this.flags.set(k, [label, cond]); return this; }
    searchOn(...keys) { this.search.push(...keys); return this; }
    sort(k, dir) { this.defaultSort = k; this.defaultDir = dir; return this; }
    selectList() { return this.fields.map(f => f.selectExpr() + ' AS ' + f.key).join(', '); }
  }
  const F = (key, label, type, sql) => new Field(key, label, type, sql);
  const DEPTS = ['CSE', 'IT', 'ECE', 'EEE', 'Mechanical', 'Civil', 'Other'];
  const PHONE = ['[0-9+ -]{7,15}', 'Enter a valid phone number.'];
  const EMAIL = ['[^@\\s]+@[^@\\s]+\\.[^@\\s]+', 'Enter a valid email address.'];

  (function defineTables() {
    // ---- rooms (room number is typed in, so no AUTOINCREMENT)
    const rooms = new TableDef('rooms', 'Rooms', 'ROOM', 'ROOM R', 'room_no', 'R.ROOM_NO', false);
    rooms.add(F('room_no', 'Room No', 'int', 'R.ROOM_NO').c('ROOM_NO').req().mn(1).mx(9999).createOnlyF());
    rooms.add(F('block', 'Block', 'str', 'R.BLOCK').c('BLOCK').req().len(10).filt().refTo('blocks'));
    rooms.add(F('capacity', 'Capacity', 'int', 'R.CAPACITY').c('CAPACITY').req().mn(1).mx(99));
    rooms.add(F('occupied', 'Occupied', 'int', 'R.OCCUPIED').c('OCCUPIED').noForm().def('0'));
    rooms.add(F('vacant', 'Vacant', 'int', '(R.CAPACITY - R.OCCUPIED)').noForm());
    rooms.add(F('occupancy', 'Occupancy %', 'int', 'ROUND(R.OCCUPIED * 100.0 / NULLIF(R.CAPACITY, 0), 0)').noForm());
    rooms.add(F('rent', 'Rent', 'num', 'R.RENT').c('RENT').req().mn(1).mx(999999.99).rng());
    rooms.searchOn('room_no', 'block');
    rooms.flag('vacant', 'Has vacancy', 'R.OCCUPIED < R.CAPACITY').flag('full', 'Full', 'R.OCCUPIED >= R.CAPACITY').flag('empty', 'Empty', 'R.OCCUPIED = 0');
    rooms.check = (v, id) => {
      if (id != null && v.capacity != null) {
        const occ = num('SELECT OCCUPIED FROM ROOM WHERE ROOM_NO = ?', id);
        if (v.capacity < occ) throw bad('Capacity cannot be less than the ' + occ + ' students already in this room.');
      }
    };
    TABLES.set(rooms.key, rooms);

    // ---- students
    const st = new TableDef('students', 'Students', 'STUDENT', 'STUDENT S LEFT JOIN ROOM R ON R.ROOM_NO = S.ROOM_NO', 'student_id', 'S.STUDENT_ID', true);
    st.add(F('student_id', 'ID', 'int', 'S.STUDENT_ID').noForm());
    st.add(F('reg_no', 'Reg No', 'str', 'S.REG_NO').c('REG_NO').req().len(15).pat('[A-Za-z0-9]+', 'Reg No can have only letters and digits.'));
    st.add(F('name', 'Name', 'str', 'S.NAME').c('NAME').req().len(50));
    st.add(F('department', 'Department', 'str', 'S.DEPARTMENT').c('DEPARTMENT').req().opts(...DEPTS).filt());
    st.add(F('year_of_study', 'Year', 'int', 'S.YEAR_OF_STUDY').c('YEAR_OF_STUDY').req().mn(1).mx(5).filt());
    st.add(F('phone', 'Phone', 'str', 'S.PHONE').c('PHONE').len(15).pat(...PHONE));
    st.add(F('email', 'Email', 'str', 'S.EMAIL').c('EMAIL').len(60).pat(...EMAIL));
    st.add(F('guardian_phone', 'Guardian Phone', 'str', 'S.GUARDIAN_PHONE').c('GUARDIAN_PHONE').len(15).pat(...PHONE).noList());
    st.add(F('room_no', 'Room', 'int', 'S.ROOM_NO').noForm().filt().refTo('rooms'));
    st.add(F('block', 'Block', 'str', 'R.BLOCK').noForm().filt().refTo('blocks'));
    st.add(F('join_date', 'Joined', 'date', 'S.JOIN_DATE').c('JOIN_DATE').def(TODAY).rng());
    st.searchOn('name', 'reg_no', 'department', 'phone', 'email', 'room_no');
    st.flag('unallotted', 'No room yet', 'S.ROOM_NO IS NULL').flag('allotted', 'Has a room', 'S.ROOM_NO IS NOT NULL');
    st.beforeDelete = id => {
      const s = one('SELECT ROOM_NO FROM STUDENT WHERE STUDENT_ID = ?', id);
      if (s && s.room_no != null) exec('UPDATE ROOM SET OCCUPIED = OCCUPIED - 1 WHERE ROOM_NO = ?', s.room_no);
    };
    TABLES.set(st.key, st);

    // ---- wardens
    const wd = new TableDef('wardens', 'Wardens', 'WARDEN', 'WARDEN W', 'warden_id', 'W.WARDEN_ID', true);
    wd.add(F('warden_id', 'ID', 'int', 'W.WARDEN_ID').noForm());
    wd.add(F('name', 'Name', 'str', 'W.NAME').c('NAME').req().len(50));
    wd.add(F('phone', 'Phone', 'str', 'W.PHONE').c('PHONE').len(15).pat(...PHONE));
    wd.add(F('email', 'Email', 'str', 'W.EMAIL').c('EMAIL').len(60).pat(...EMAIL));
    wd.add(F('block', 'Block', 'str', 'W.BLOCK').c('BLOCK').req().len(10).filt().refTo('blocks'));
    wd.add(F('shift_time', 'Shift', 'str', 'W.SHIFT_TIME').c('SHIFT_TIME').opts('Morning', 'Evening', 'Night').filt());
    wd.searchOn('name', 'phone', 'email', 'block');
    TABLES.set(wd.key, wd);

    // ---- fees
    const fee = new TableDef('fees', 'Fees', 'FEE', 'FEE F JOIN STUDENT S ON S.STUDENT_ID = F.STUDENT_ID', 'fee_id', 'F.FEE_ID', true);
    fee.add(F('fee_id', 'ID', 'int', 'F.FEE_ID').noForm());
    fee.add(F('student_id', 'Student', 'int', 'F.STUDENT_ID').c('STUDENT_ID').req().refTo('students').filt().noList());
    fee.add(F('student_name', 'Student', 'str', 'S.NAME').noForm());
    fee.add(F('reg_no', 'Reg No', 'str', 'S.REG_NO').noForm());
    fee.add(F('fee_type', 'Type', 'str', 'F.FEE_TYPE').c('FEE_TYPE').req().opts('Room Rent', 'Mess', 'Maintenance', 'Fine', 'Other').filt());
    fee.add(F('amount', 'Amount', 'num', 'F.AMOUNT').c('AMOUNT').req().mn(1).mx(999999.99).rng());
    fee.add(F('due_date', 'Due Date', 'date', 'F.DUE_DATE').c('DUE_DATE').req().rng());
    fee.add(F('paid_date', 'Paid On', 'date', 'F.PAID_DATE').c('PAID_DATE').hlp('Leave empty if not paid yet'));
    fee.add(F('pay_mode', 'Pay Mode', 'str', 'F.PAY_MODE').c('PAY_MODE').opts('Cash', 'UPI', 'Card', 'Net Banking').filt());
    fee.add(F('status', 'Status', 'str', "(CASE WHEN F.PAID_DATE IS NOT NULL THEN 'Paid' WHEN F.DUE_DATE < " + TODAY + " THEN 'Overdue' ELSE 'Pending' END)")
      .noForm().opts('Paid', 'Pending', 'Overdue').filt());
    fee.searchOn('student_name', 'reg_no', 'fee_type');
    fee.sort('due_date', 'desc');
    fee.check = v => {
      if (v.paid_date != null && v.pay_mode == null) throw bad('Choose the payment mode for a paid fee.');
      if (v.paid_date == null && v.pay_mode != null) throw bad('Add the paid date, or clear the payment mode.');
    };
    TABLES.set(fee.key, fee);

    // ---- complaints
    const cp = new TableDef('complaints', 'Complaints', 'COMPLAINT', 'COMPLAINT C JOIN STUDENT S ON S.STUDENT_ID = C.STUDENT_ID', 'complaint_id', 'C.COMPLAINT_ID', true);
    cp.add(F('complaint_id', 'ID', 'int', 'C.COMPLAINT_ID').noForm());
    cp.add(F('student_id', 'Student', 'int', 'C.STUDENT_ID').c('STUDENT_ID').req().refTo('students').filt().noList());
    cp.add(F('student_name', 'Student', 'str', 'S.NAME').noForm());
    cp.add(F('room_no', 'Room', 'int', 'S.ROOM_NO').noForm());
    cp.add(F('category', 'Category', 'str', 'C.CATEGORY').c('CATEGORY').req().opts('Electrical', 'Plumbing', 'Furniture', 'Cleaning', 'Internet', 'Other').filt());
    cp.add(F('description', 'Description', 'text', 'C.DESCRIPTION').c('DESCRIPTION').req().len(300));
    cp.add(F('priority', 'Priority', 'str', 'C.PRIORITY').c('PRIORITY').opts('Low', 'Medium', 'High').def("'Medium'").filt());
    cp.add(F('status', 'Status', 'str', 'C.STATUS').c('STATUS').noForm().def("'Open'").opts('Open', 'In Progress', 'Resolved').filt());
    cp.add(F('created_on', 'Raised On', 'date', 'C.CREATED_ON').c('CREATED_ON').noForm().def(NOW).rng());
    cp.add(F('resolved_on', 'Resolved On', 'date', 'C.RESOLVED_ON').noForm());
    cp.searchOn('student_name', 'category', 'description');
    cp.sort('complaint_id', 'desc');
    TABLES.set(cp.key, cp);

    // ---- visitors
    const vs = new TableDef('visitors', 'Visitors', 'VISITOR', 'VISITOR V JOIN STUDENT S ON S.STUDENT_ID = V.STUDENT_ID', 'visitor_id', 'V.VISITOR_ID', true);
    vs.add(F('visitor_id', 'ID', 'int', 'V.VISITOR_ID').noForm());
    vs.add(F('student_id', 'Student', 'int', 'V.STUDENT_ID').c('STUDENT_ID').req().refTo('students').filt().noList());
    vs.add(F('student_name', 'Visiting', 'str', 'S.NAME').noForm());
    vs.add(F('visitor_name', 'Visitor', 'str', 'V.VISITOR_NAME').c('VISITOR_NAME').req().len(50));
    vs.add(F('relation', 'Relation', 'str', 'V.RELATION').c('RELATION').opts('Parent', 'Sibling', 'Relative', 'Friend', 'Other').filt());
    vs.add(F('phone', 'Phone', 'str', 'V.PHONE').c('PHONE').len(15).pat(...PHONE));
    vs.add(F('in_time', 'Check-in', 'datetime', 'V.IN_TIME').c('IN_TIME').def(NOW).hlp('Leave empty to use the current time'));
    vs.add(F('out_time', 'Check-out', 'datetime', 'V.OUT_TIME').c('OUT_TIME'));
    vs.add(F('presence', 'Status', 'str', "(CASE WHEN V.OUT_TIME IS NULL THEN 'Inside' ELSE 'Left' END)").noForm().opts('Inside', 'Left').filt());
    vs.searchOn('visitor_name', 'student_name', 'phone');
    vs.sort('in_time', 'desc');
    vs.check = v => {
      if (v.in_time != null && v.out_time != null && v.out_time < v.in_time) throw bad('Check-out cannot be before check-in.');
    };
    TABLES.set(vs.key, vs);

    // ---- leave requests
    const lv = new TableDef('leaves', 'Leave Requests', 'LEAVE_REQUEST', 'LEAVE_REQUEST L JOIN STUDENT S ON S.STUDENT_ID = L.STUDENT_ID', 'leave_id', 'L.LEAVE_ID', true);
    lv.add(F('leave_id', 'ID', 'int', 'L.LEAVE_ID').noForm());
    lv.add(F('student_id', 'Student', 'int', 'L.STUDENT_ID').c('STUDENT_ID').req().refTo('students').filt().noList());
    lv.add(F('student_name', 'Student', 'str', 'S.NAME').noForm());
    lv.add(F('leave_from', 'From', 'date', 'L.LEAVE_FROM').c('LEAVE_FROM').req().rng());
    lv.add(F('leave_to', 'To', 'date', 'L.LEAVE_TO').c('LEAVE_TO').req());
    lv.add(F('reason', 'Reason', 'text', 'L.REASON').c('REASON').req().len(200));
    lv.add(F('status', 'Status', 'str', 'L.STATUS').c('STATUS').noForm().def("'Pending'").opts('Pending', 'Approved', 'Rejected').filt());
    lv.add(F('applied_on', 'Applied On', 'date', 'L.APPLIED_ON').c('APPLIED_ON').noForm().def(NOW));
    lv.searchOn('student_name', 'reason');
    lv.sort('leave_id', 'desc');
    lv.check = v => {
      if (v.leave_from != null && v.leave_to != null && v.leave_to < v.leave_from) throw bad('Leave end date cannot be before the start date.');
    };
    TABLES.set(lv.key, lv);

    // ---- inventory
    const inv = new TableDef('inventory', 'Room Inventory', 'INVENTORY', 'INVENTORY I JOIN ROOM R ON R.ROOM_NO = I.ROOM_NO', 'item_id', 'I.ITEM_ID', true);
    inv.add(F('item_id', 'ID', 'int', 'I.ITEM_ID').noForm());
    inv.add(F('room_no', 'Room', 'int', 'I.ROOM_NO').c('ROOM_NO').req().refTo('rooms').filt());
    inv.add(F('block', 'Block', 'str', 'R.BLOCK').noForm().filt().refTo('blocks'));
    inv.add(F('item_name', 'Item', 'str', 'I.ITEM_NAME').c('ITEM_NAME').req().len(40));
    inv.add(F('quantity', 'Qty', 'int', 'I.QUANTITY').c('QUANTITY').req().mn(0).mx(999));
    inv.add(F('item_condition', 'Condition', 'str', 'I.ITEM_CONDITION').c('ITEM_CONDITION').req().opts('Good', 'Needs Repair', 'Damaged').filt());
    inv.add(F('last_checked', 'Last Checked', 'date', 'I.LAST_CHECKED').c('LAST_CHECKED').rng());
    inv.searchOn('item_name', 'room_no', 'block');
    inv.flag('attention', 'Needs attention', "I.ITEM_CONDITION <> 'Good'");
    inv.sort('room_no', 'asc');
    TABLES.set(inv.key, inv);

    // ---- notices
    const nt = new TableDef('notices', 'Notice Board', 'NOTICE', 'NOTICE N', 'notice_id', 'N.NOTICE_ID', true);
    nt.add(F('notice_id', 'ID', 'int', 'N.NOTICE_ID').noForm());
    nt.add(F('title', 'Title', 'str', 'N.TITLE').c('TITLE').req().len(80));
    nt.add(F('body', 'Message', 'text', 'N.BODY').c('BODY').req().len(1000));
    nt.add(F('priority', 'Priority', 'str', 'N.PRIORITY').c('PRIORITY').opts('Normal', 'Important', 'Urgent').def("'Normal'").filt());
    nt.add(F('posted_by', 'Posted By', 'str', 'N.POSTED_BY').c('POSTED_BY').auto());
    nt.add(F('posted_on', 'Posted On', 'date', 'N.POSTED_ON').c('POSTED_ON').noForm().def(NOW).rng());
    nt.searchOn('title', 'body');
    nt.sort('notice_id', 'desc');
    TABLES.set(nt.key, nt);

    // ---- audit log (read only)
    const au = new TableDef('audit', 'Audit Log', 'AUDIT_LOG', 'AUDIT_LOG A', 'log_id', 'A.LOG_ID', true);
    au.readOnly = true; au.adminOnly = true;
    au.add(F('log_id', 'ID', 'int', 'A.LOG_ID'));
    au.add(F('log_time', 'When', 'datetime', 'A.LOG_TIME').rng());
    au.add(F('username', 'User', 'str', 'A.USERNAME').filt().refTo('users'));
    au.add(F('action', 'Action', 'str', 'A.ACTION').opts('CREATE', 'UPDATE', 'DELETE', 'ALLOT', 'VACATE', 'PAY', 'STATUS', 'CHECKOUT', 'DECISION', 'GENERATE', 'PASSWORD').filt());
    au.add(F('table_name', 'Table', 'str', 'A.TABLE_NAME').filt());
    au.add(F('detail', 'Detail', 'text', 'A.DETAIL'));
    au.searchOn('username', 'action', 'table_name', 'detail');
    au.sort('log_id', 'desc');
    TABLES.set(au.key, au);
  })();

  // ============================================================ meta
  function meta(r) {
    const admin = r.s.role === 'ADMIN';
    const tables = {};
    for (const t of TABLES.values()) {
      if (t.adminOnly && !admin) continue;
      const fl = t.fields.map(f => {
        const m = { key: f.key, label: f.label, type: f.type, required: f.required, list: f.list,
          form: f.form && f.col != null, createOnly: f.createOnly, filter: f.filter, range: f.range };
        if (f.options) m.options = f.options;
        if (f.ref) m.ref = f.ref;
        if (f.min != null) m.min = f.min;
        if (f.max != null) m.max = f.max;
        if (f.maxLen != null) m.maxLen = f.maxLen;
        if (f.help != null) m.help = f.help;
        return m;
      });
      const flags = [...t.flags].map(([k, v]) => map('key', k, 'label', v[0]));
      tables[t.key] = map('key', t.key, 'title', t.title, 'pk', t.pk, 'readOnly', t.readOnly,
        'searchable', t.search.length > 0, 'defaultSort', t.defaultSort, 'defaultDir', t.defaultDir,
        'fields', fl, 'flags', flags);
    }
    return map('user', map('username', r.s.user, 'role', r.s.role), 'tables', tables);
  }

  // ============================================================ generic table routes
  async function tableRoute(r, t) {
    const sg = r.seg, m = r.method, user = r.s.user;
    if (sg.length === 2) {
      if (m === 'GET') return list(t, r.q);
      if (m === 'POST' && !t.readOnly) return tx(() => create(t, r.body, user));
      throw new ApiException(405, 'Method not allowed.');
    }
    const idStr = sg[2];
    if (t.key === 'fees' && idStr === 'generate' && sg.length === 3) {
      if (m !== 'POST') throw new ApiException(405, 'Method not allowed.');
      return generateFees(r);
    }
    if (sg.length === 3) {
      if (t.readOnly && m !== 'GET') throw new ApiException(405, 'Read only.');
      if (m === 'GET') {
        const id = idOf(idStr);
        const row = one('SELECT ' + t.selectList() + ' FROM ' + t.from + ' WHERE ' + t.pkSql + ' = ?', id);
        if (!row) throw new ApiException(404, 'Record not found.');
        return row;
      }
      if (m === 'PUT') { const id = idOf(idStr); return tx(() => update(t, id, r.body, user)); }
      if (m === 'DELETE') { const id = idOf(idStr); r.op = 'DELETE'; return tx(() => remove(t, id, user)); }
      throw new ApiException(405, 'Method not allowed.');
    }
    // /api/{table}/{id}/{action}
    if (m !== 'POST') throw new ApiException(405, 'Method not allowed.');
    if (sg.length === 4) return action(r, t, idOf(idStr), sg[3]);
    throw new ApiException(404, 'Unknown action.');
  }

  function filterValue(f, v) {
    if (f.type === 'int') { if (!/^[+-]?\d+$/.test(v.trim())) throw bad('Invalid value for ' + f.label + '.'); return Number(v.trim()); }
    if (f.type === 'num') { if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v.trim())) throw bad('Invalid value for ' + f.label + '.'); return Number(v.trim()); }
    return v;
  }
  const intParam = (s, d) => /^[+-]?\d{1,9}$/.test(s == null ? '' : s) ? parseInt(s, 10) : d;

  function list(t, q) {
    let where = ' WHERE 1 = 1';
    const ps = [];
    const s = (q.get('q') || '').trim();
    if (s && t.search.length) {
      where += ' AND (' + t.search.map(k => {
        const f = t.field(k);
        const x = (f.type === 'int' || f.type === 'num') ? 'CAST(' + f.sql + ' AS TEXT)' : f.sql;
        ps.push('%' + escLike(s.toUpperCase()) + '%');
        return 'UPPER(' + x + ") LIKE ? ESCAPE '\\'";
      }).join(' OR ') + ')';
    }
    for (const f of t.fields) {
      if (f.filter) {
        const v = q.get('f_' + f.key);
        if (v != null && v !== '') { where += ' AND ' + f.sql + ' = ?'; ps.push(filterValue(f, v)); }
      }
      if (f.range) {
        const lo = q.get(f.key + '_min'), hi = q.get(f.key + '_max');
        const isDt = f.type === 'date' || f.type === 'datetime';
        if (lo != null && lo !== '') {
          if (isDt) { if (!isDate(lo)) throw bad('Invalid date.'); where += ' AND ' + f.sql + ' >= ?'; ps.push(lo); }
          else { where += ' AND ' + f.sql + ' >= ?'; ps.push(filterValue(f, lo)); }
        }
        if (hi != null && hi !== '') {
          if (isDt) { if (!isDate(hi)) throw bad('Invalid date.'); where += ' AND ' + f.sql + " < date(?, '+1 day')"; ps.push(hi); }
          else { where += ' AND ' + f.sql + ' <= ?'; ps.push(filterValue(f, hi)); }
        }
      }
    }
    for (const [k, v] of t.flags) if (q.get('flag_' + k) === '1') where += ' AND (' + v[1] + ')';

    const sf = t.field(q.has('sort') ? q.get('sort') : t.defaultSort) || t.field(t.defaultSort);
    const dir = String(q.has('dir') ? q.get('dir') : t.defaultDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const order = ' ORDER BY ' + sf.sql + ' ' + dir + ' NULLS LAST, ' + t.pkSql + ' ' + dir;

    const exportAll = q.get('export') === '1';
    let size = intParam(q.has('size') ? q.get('size') : '10', 10), page = intParam(q.has('page') ? q.get('page') : '1', 1);
    size = Math.max(1, Math.min(size, exportAll ? 10000 : 100));
    page = Math.max(1, page);

    const total = num('SELECT COUNT(*) FROM ' + t.from + where, ...ps);
    const data = rows('SELECT ' + t.selectList() + ' FROM ' + t.from + where + order + ' LIMIT ? OFFSET ?', ...ps, size, (page - 1) * size);
    return map('rows', data, 'total', total, 'page', page, 'size', size, 'pages', Math.max(1, Math.ceil(total / size)));
  }

  /** validates the request body against the field rules; returns a Map field -> typed value */
  function validate(t, body, creating) {
    const out = new Map();
    for (const f of t.fields) {
      if (f.col == null || !f.form) continue;
      if (!creating && f.createOnly) continue;
      if (!creating && !Object.prototype.hasOwnProperty.call(body, f.key)) continue;
      let s = text(body, f.key);
      if (!s) {
        if (f.required) throw bad(f.label + ' is required.');
        out.set(f, null);
        continue;
      }
      switch (f.type) {
        case 'int': {
          if (!full('-?\\d{1,9}', s)) throw bad(f.label + ' must be a whole number.');
          const v = parseInt(s, 10);
          if (f.min != null && v < f.min) throw bad(f.label + ' must be at least ' + Math.trunc(f.min) + '.');
          if (f.max != null && v > f.max) throw bad(f.label + ' must be at most ' + Math.trunc(f.max) + '.');
          out.set(f, v);
          break;
        }
        case 'num': {
          if (!full('\\d{1,8}(\\.\\d{1,2})?', s)) throw bad(f.label + ' must be a number (up to 2 decimals).');
          const v = Number(s);
          if (f.min != null && v < f.min) throw bad(f.label + ' must be at least ' + Math.trunc(f.min) + '.');
          if (f.max != null && v > f.max) throw bad(f.label + ' is too large.');
          out.set(f, v);
          break;
        }
        case 'date':
          if (!isDate(s)) throw bad(f.label + ' must be a valid date.');
          out.set(f, s);
          break;
        case 'datetime': {
          const v = s.replace('T', ' ');
          const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(v);
          if (!m || !isDate(m[1]) || +m[2] > 23 || +m[3] > 59) throw bad(f.label + ' must be a valid date and time.');
          out.set(f, v);
          break;
        }
        default: {
          if (f.maxLen != null && s.length > f.maxLen) throw bad(f.label + ' can have at most ' + f.maxLen + ' characters.');
          if (f.options) {
            const hit = f.options.filter(o => o.toLowerCase() === s.toLowerCase()).pop();
            if (hit == null) throw bad(f.label + ' must be one of: ' + f.options.join(', ') + '.');
            s = hit;
          }
          if (f.pattern != null && !full(f.pattern, s)) throw bad(f.patternHint != null ? f.patternHint : f.label + ' is not valid.');
          out.set(f, s);
        }
      }
    }
    return out;
  }
  function placeholder(f) {
    if (f.type === 'date') return 'date(?)';
    if (f.type === 'datetime') return 'datetime(?)';
    return '?';
  }
  function byKey(vals) { const m = {}; for (const [f, v] of vals) m[f.key] = v; return m; }
  function describe(vals) {
    let b = '';
    for (const [f, v] of vals) {
      if (v == null || f.type === 'text') continue;
      if (b) b += ', ';
      b += f.label + '=' + v;
      if (b.length > 160) break;
    }
    return b;
  }

  function create(t, body, user) {
    const vals = validate(t, body, true);
    if (t.check) t.check(byKey(vals), null);
    const cols = [], ph = [], ps = [];
    for (const f of t.fields) {
      if (f.col == null) continue;
      if (f.autoUser) { cols.push(f.col); ph.push('?'); ps.push(user); continue; }
      const v = f.form ? vals.get(f) : null;
      if (v != null) { cols.push(f.col); ph.push(placeholder(f)); ps.push(v); }
      else if (f.defaultSql != null) { cols.push(f.col); ph.push(f.defaultSql); }
    }
    exec('INSERT INTO ' + t.dbName + ' (' + cols.join(', ') + ') VALUES (' + ph.join(', ') + ')', ...ps);
    const id = t.auto ? num('SELECT last_insert_rowid()') : vals.get(t.field(t.pk));
    audit(user, 'CREATE', t.dbName, '#' + id + ' ' + describe(vals));
    return map('ok', true, 'id', id);
  }

  function update(t, id, body, user) {
    const vals = validate(t, body, false);
    if (num('SELECT COUNT(*) FROM ' + t.dbName + ' WHERE ' + t.pkCol() + ' = ?', id) === 0)
      throw new ApiException(404, 'Record not found.');
    if (t.check) t.check(byKey(vals), id);
    if (!vals.size) throw bad('Nothing to update.');
    const sets = [], ps = [];
    for (const [f, v] of vals) {
      if (v == null) sets.push(f.col + ' = ' + (f.defaultSql != null ? f.defaultSql : 'NULL'));
      else { sets.push(f.col + ' = ' + placeholder(f)); ps.push(v); }
    }
    ps.push(id);
    exec('UPDATE ' + t.dbName + ' SET ' + sets.join(', ') + ' WHERE ' + t.pkCol() + ' = ?', ...ps);
    audit(user, 'UPDATE', t.dbName, '#' + id + ' ' + describe(vals));
    return map('ok', true);
  }

  function remove(t, id, user) {
    const row = one('SELECT ' + t.selectList() + ' FROM ' + t.from + ' WHERE ' + t.pkSql + ' = ?', id);
    if (!row) throw new ApiException(404, 'Record not found.');
    if (t.beforeDelete) t.beforeDelete(id);
    exec('DELETE FROM ' + t.dbName + ' WHERE ' + t.pkCol() + ' = ?', id);
    let d = '#' + id;
    for (const f of t.fields) {
      const v = row[f.key];
      if (v != null && f.list && f.type === 'str' && d.length < 120) d += ' ' + v;
    }
    audit(user, 'DELETE', t.dbName, d);
    return map('ok', true);
  }

  // ============================================================ special actions
  function pick(options, v) { return options.filter(o => o.toLowerCase() === v.toLowerCase()).pop() || null; }

  function action(r, t, id, act) {
    const user = r.s.user, b = r.body;
    switch (t.key + '/' + act) {
      case 'students/allot': {
        if (!text(b, 'room_no')) throw bad('Choose a room.');
        const room = idOf(text(b, 'room_no'));
        return tx(() => {
          const s = one('SELECT ROOM_NO FROM STUDENT WHERE STUDENT_ID = ?', id);
          if (!s) throw new ApiException(404, 'Student not found.');
          const old = s.room_no;
          if (old != null && old === room) throw bad('The student is already in that room.');
          const rm = one('SELECT CAPACITY, OCCUPIED FROM ROOM WHERE ROOM_NO = ?', room);
          if (!rm) throw bad('That room does not exist.');
          if (rm.occupied >= rm.capacity) throw new ApiException(409, 'Room ' + room + ' is full.');
          if (old != null) exec('UPDATE ROOM SET OCCUPIED = OCCUPIED - 1 WHERE ROOM_NO = ?', old);
          exec('UPDATE ROOM SET OCCUPIED = OCCUPIED + 1 WHERE ROOM_NO = ?', room);
          exec('UPDATE STUDENT SET ROOM_NO = ? WHERE STUDENT_ID = ?', room, id);
          audit(user, 'ALLOT', 'STUDENT', 'student #' + id + ' -> room ' + room + (old != null ? ' (from ' + old + ')' : ''));
          return map('ok', true);
        });
      }
      case 'students/vacate':
        return tx(() => {
          const s = one('SELECT ROOM_NO FROM STUDENT WHERE STUDENT_ID = ?', id);
          if (!s) throw new ApiException(404, 'Student not found.');
          if (s.room_no == null) throw bad('The student has no room.');
          exec('UPDATE ROOM SET OCCUPIED = OCCUPIED - 1 WHERE ROOM_NO = ?', s.room_no);
          exec('UPDATE STUDENT SET ROOM_NO = NULL WHERE STUDENT_ID = ?', id);
          audit(user, 'VACATE', 'STUDENT', 'student #' + id + ' left room ' + s.room_no);
          return map('ok', true);
        });
      case 'fees/pay': {
        const pm = pick(['Cash', 'UPI', 'Card', 'Net Banking'], text(b, 'pay_mode'));
        if (!pm) throw bad('Choose a payment mode.');
        return tx(() => {
          const n = exec('UPDATE FEE SET PAID_DATE = ' + TODAY + ', PAY_MODE = ? WHERE FEE_ID = ? AND PAID_DATE IS NULL', pm, id);
          if (n === 0) throw new ApiException(409, 'This fee is already paid (or does not exist).');
          audit(user, 'PAY', 'FEE', 'fee #' + id + ' paid by ' + pm);
          return map('ok', true);
        });
      }
      case 'complaints/status': {
        const ns = pick(['Open', 'In Progress', 'Resolved'], text(b, 'status'));
        if (!ns) throw bad('Status must be Open, In Progress or Resolved.');
        return tx(() => {
          const n = exec("UPDATE COMPLAINT SET STATUS = ?, RESOLVED_ON = CASE WHEN ? = 'Resolved' THEN " + TODAY + ' ELSE NULL END WHERE COMPLAINT_ID = ?', ns, ns, id);
          if (n === 0) throw new ApiException(404, 'Complaint not found.');
          audit(user, 'STATUS', 'COMPLAINT', 'complaint #' + id + ' -> ' + ns);
          return map('ok', true);
        });
      }
      case 'visitors/checkout':
        return tx(() => {
          const n = exec('UPDATE VISITOR SET OUT_TIME = ' + NOW + ' WHERE VISITOR_ID = ? AND OUT_TIME IS NULL', id);
          if (n === 0) throw new ApiException(409, 'Visitor already checked out (or does not exist).');
          audit(user, 'CHECKOUT', 'VISITOR', 'visitor #' + id);
          return map('ok', true);
        });
      case 'leaves/decision': {
        const st = text(b, 'status').toLowerCase();
        const ns = st === 'approved' ? 'Approved' : st === 'rejected' ? 'Rejected' : null;
        if (!ns) throw bad('Decision must be Approved or Rejected.');
        return tx(() => {
          const n = exec("UPDATE LEAVE_REQUEST SET STATUS = ? WHERE LEAVE_ID = ? AND STATUS = 'Pending'", ns, id);
          if (n === 0) throw new ApiException(409, 'This request was already decided (or does not exist).');
          audit(user, 'DECISION', 'LEAVE_REQUEST', 'leave #' + id + ' ' + ns);
          return map('ok', true);
        });
      }
      default:
        throw new ApiException(404, 'Unknown action.');
    }
  }

  /** POST /api/fees/generate : bill every student that has a room */
  function generateFees(r) {
    const b = r.body;
    const ft = pick(['Room Rent', 'Mess', 'Maintenance', 'Fine', 'Other'], text(b, 'fee_type')), due = text(b, 'due_date');
    const useRent = b.use_room_rent === true;
    if (!ft) throw bad('Choose a fee type.');
    if (!isDate(due)) throw bad('Choose a valid due date.');
    let fixed = null;
    if (!useRent) {
      const a = text(b, 'amount');
      if (!full('\\d{1,8}(\\.\\d{1,2})?', a) || !(Number(a) > 0)) throw bad('Enter a valid amount.');
      fixed = Number(a);
    }
    const user = r.s.user;
    return tx(() => {
      const targets = rows(
        'SELECT S.STUDENT_ID AS STUDENT_ID, R.RENT AS RENT FROM STUDENT S JOIN ROOM R ON R.ROOM_NO = S.ROOM_NO ' +
        'WHERE NOT EXISTS (SELECT 1 FROM FEE F WHERE F.STUDENT_ID = S.STUDENT_ID AND F.FEE_TYPE = ? AND F.DUE_DATE = date(?)) ' +
        'ORDER BY S.STUDENT_ID', ft, due);
      for (const t of targets)
        exec('INSERT INTO FEE (STUDENT_ID, FEE_TYPE, AMOUNT, DUE_DATE) VALUES (?, ?, ?, date(?))', t.student_id, ft, fixed != null ? fixed : t.rent, due);
      audit(user, 'GENERATE', 'FEE', targets.length + ' x ' + ft + ' due ' + due);
      return map('ok', true, 'created', targets.length);
    });
  }

  // ============================================================ lookups & search
  function lookup(what) {
    switch (what) {
      case 'rooms':
        return rows('SELECT ROOM_NO AS ROOM_NO, BLOCK AS BLOCK, CAPACITY AS CAPACITY, OCCUPIED AS OCCUPIED FROM ROOM ORDER BY ROOM_NO')
          .map(m => map('id', m.room_no, 'label', m.room_no + ' - ' + m.block, 'free', m.capacity - m.occupied));
      case 'students':
        return rows('SELECT STUDENT_ID AS STUDENT_ID, NAME AS NAME, REG_NO AS REG_NO, ROOM_NO AS ROOM_NO FROM STUDENT ORDER BY NAME')
          .map(m => map('id', m.student_id, 'label', m.name + ' (' + m.reg_no + ')', 'room_no', m.room_no));
      case 'blocks':
        return grid('SELECT DISTINCT BLOCK FROM ROOM ORDER BY BLOCK').map(g => map('id', g[0], 'label', g[0]));
      case 'users':
        return grid('SELECT USERNAME FROM APP_USER ORDER BY USERNAME').map(g => map('id', g[0], 'label', g[0]));
      default: throw new ApiException(404, 'Unknown lookup.');
    }
  }

  function search(q) {
    if (q.length < 2) return map('results', []);
    const like = '%' + escLike(q.toUpperCase()) + '%';
    const E = " ESCAPE '\\'";
    const sql =
      'SELECT * FROM (' +
      "SELECT 'students' AS kind, STUDENT_ID AS id, NAME AS label, REG_NO AS sub FROM STUDENT WHERE UPPER(NAME) LIKE ?" + E + ' OR UPPER(REG_NO) LIKE ?' + E +
      " UNION ALL SELECT 'rooms', ROOM_NO, 'Room ' || ROOM_NO, BLOCK FROM ROOM WHERE UPPER(CAST(ROOM_NO AS TEXT)) LIKE ?" + E + ' OR UPPER(BLOCK) LIKE ?' + E +
      " UNION ALL SELECT 'wardens', WARDEN_ID, NAME, BLOCK FROM WARDEN WHERE UPPER(NAME) LIKE ?" + E +
      " UNION ALL SELECT 'complaints', COMPLAINT_ID, CATEGORY, SUBSTR(DESCRIPTION, 1, 60) FROM COMPLAINT WHERE UPPER(DESCRIPTION) LIKE ?" + E + ' OR UPPER(CATEGORY) LIKE ?' + E +
      " UNION ALL SELECT 'notices', NOTICE_ID, TITLE, PRIORITY FROM NOTICE WHERE UPPER(TITLE) LIKE ?" + E +
      ') LIMIT 12';
    return map('results', rows(sql, like, like, like, like, like, like, like, like));
  }

  // ============================================================ dashboard
  function dashboard(admin) {
    const d = {};
    const rm = one('SELECT COUNT(*) AS rooms, IFNULL(SUM(CAPACITY), 0) AS capacity, IFNULL(SUM(OCCUPIED), 0) AS occupied FROM ROOM');
    const sd = one('SELECT COUNT(*) AS total, IFNULL(SUM(CASE WHEN ROOM_NO IS NULL THEN 1 ELSE 0 END), 0) AS unallotted FROM STUDENT');
    const fe = one(
      'SELECT ROUND(IFNULL(SUM(CASE WHEN PAID_DATE IS NULL THEN AMOUNT ELSE 0 END), 0), 2) AS pending, ' +
      'ROUND(IFNULL(SUM(CASE WHEN PAID_DATE IS NOT NULL THEN AMOUNT ELSE 0 END), 0), 2) AS collected, ' +
      'ROUND(IFNULL(SUM(CASE WHEN PAID_DATE IS NULL AND DUE_DATE < ' + TODAY + ' THEN AMOUNT ELSE 0 END), 0), 2) AS overdue, ' +
      'IFNULL(SUM(CASE WHEN PAID_DATE IS NULL AND DUE_DATE < ' + TODAY + ' THEN 1 ELSE 0 END), 0) AS overdue_count FROM FEE');
    const cap = rm.capacity, occ = rm.occupied;
    d.kpis = {
      rooms: rm.rooms, capacity: cap, occupied: occ, vacant: cap - occ,
      occupancy: cap === 0 ? 0 : Math.round(occ * 1000 / cap) / 10,
      students: sd.total, unallotted: sd.unallotted,
      wardens: num('SELECT COUNT(*) FROM WARDEN'),
      fees_pending: fe.pending, fees_collected: fe.collected, fees_overdue: fe.overdue, fees_overdue_count: fe.overdue_count,
      complaints_open: num("SELECT COUNT(*) FROM COMPLAINT WHERE STATUS <> 'Resolved'"),
      visitors_inside: num('SELECT COUNT(*) FROM VISITOR WHERE OUT_TIME IS NULL'),
      leaves_pending: num("SELECT COUNT(*) FROM LEAVE_REQUEST WHERE STATUS = 'Pending'"),
      items_attention: num("SELECT COUNT(*) FROM INVENTORY WHERE ITEM_CONDITION <> 'Good'")
    };
    d.occupancy_by_block = rows('SELECT BLOCK AS block, SUM(CAPACITY) AS capacity, SUM(OCCUPIED) AS occupied FROM ROOM GROUP BY BLOCK ORDER BY BLOCK');
    d.complaints_by_status = rows('SELECT STATUS AS label, COUNT(*) AS cnt FROM COMPLAINT GROUP BY STATUS ORDER BY STATUS');
    d.students_by_dept = rows('SELECT DEPARTMENT AS label, COUNT(*) AS cnt FROM STUDENT GROUP BY DEPARTMENT ORDER BY 2 DESC, 1');
    d.fees_by_status = [
      map('label', 'Paid', 'cnt', fe.collected),
      map('label', 'Pending', 'cnt', money2(fe.pending - fe.overdue)),
      map('label', 'Overdue', 'cnt', fe.overdue)];

    // fee collection for the last 6 months (months filled in here)
    const now = new Date(), first = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const byMonth = new Map();
    for (let i = 0; i < 6; i++) byMonth.set(ymd(new Date(first.getFullYear(), first.getMonth() + i, 1)).substring(0, 7), 0);
    for (const g of grid("SELECT strftime('%Y-%m', PAID_DATE), SUM(AMOUNT) FROM FEE WHERE PAID_DATE >= ? GROUP BY strftime('%Y-%m', PAID_DATE)", ymd(first)))
      if (byMonth.has(String(g[0]))) byMonth.set(String(g[0]), money2(g[1]));
    d.collection_by_month = [...byMonth].map(([k, v]) => map('label', k, 'cnt', v));

    d.notices = rows("SELECT NOTICE_ID AS notice_id, TITLE AS title, BODY AS body, PRIORITY AS priority, POSTED_BY AS posted_by, strftime('%Y-%m-%d', POSTED_ON) AS posted_on FROM NOTICE ORDER BY NOTICE_ID DESC LIMIT 4");
    d.overdue_fees = rows("SELECT F.FEE_ID AS fee_id, S.NAME AS name, F.FEE_TYPE AS fee_type, F.AMOUNT AS amount, strftime('%Y-%m-%d', F.DUE_DATE) AS due_date FROM FEE F JOIN STUDENT S ON S.STUDENT_ID = F.STUDENT_ID WHERE F.PAID_DATE IS NULL AND F.DUE_DATE < " + TODAY + ' ORDER BY F.DUE_DATE, F.FEE_ID LIMIT 5');
    d.open_complaints = rows("SELECT C.COMPLAINT_ID AS complaint_id, S.NAME AS name, C.CATEGORY AS category, C.PRIORITY AS priority, C.STATUS AS status, SUBSTR(C.DESCRIPTION, 1, 70) AS description FROM COMPLAINT C JOIN STUDENT S ON S.STUDENT_ID = C.STUDENT_ID WHERE C.STATUS <> 'Resolved' ORDER BY C.COMPLAINT_ID DESC LIMIT 5");
    d.activity = admin
      ? rows("SELECT USERNAME AS username, ACTION AS action, TABLE_NAME AS table_name, DETAIL AS detail, strftime('%Y-%m-%d %H:%M', LOG_TIME) AS log_time FROM AUDIT_LOG ORDER BY LOG_ID DESC LIMIT 6")
      : [];
    return d;
  }

  // ============================================================ reports
  const REPORTS = [['block-summary', 'Block-wise room summary'], ['room-vacancy', 'Rooms with vacancies'], ['room-occupants', 'Who stays where'],
    ['department-summary', 'Department-wise students'], ['fee-summary', 'Fee summary by type'], ['fee-defaulters', 'Fee defaulters (overdue)'],
    ['complaint-summary', 'Complaints by category'], ['visitor-summary', 'Visitors by relation'], ['inventory-attention', 'Items needing attention']];

  function report(name) {
    let cols, data;
    switch (name) {
      case 'block-summary':
        cols = ['Block', 'Rooms', 'Capacity', 'Occupied', 'Vacant', 'Occupancy %', 'Avg Rent', 'Rent Value'];
        data = grid('SELECT BLOCK, COUNT(*), SUM(CAPACITY), SUM(OCCUPIED), SUM(CAPACITY) - SUM(OCCUPIED), ' +
          'ROUND(SUM(OCCUPIED) * 100.0 / NULLIF(SUM(CAPACITY), 0), 1), ROUND(AVG(RENT), 2), ROUND(SUM(OCCUPIED * RENT), 2) FROM ROOM GROUP BY BLOCK ORDER BY BLOCK');
        break;
      case 'room-vacancy':
        cols = ['Room', 'Block', 'Capacity', 'Occupied', 'Free Beds', 'Rent'];
        data = grid('SELECT ROOM_NO, BLOCK, CAPACITY, OCCUPIED, CAPACITY - OCCUPIED, RENT FROM ROOM WHERE OCCUPIED < CAPACITY ORDER BY BLOCK, ROOM_NO');
        break;
      case 'room-occupants':
        cols = ['Room', 'Block', 'Occupied', 'Students'];
        data = grid("SELECT R.ROOM_NO, R.BLOCK, R.OCCUPIED, group_concat(S.NAME, ', ' ORDER BY S.NAME) " +
          'FROM ROOM R LEFT JOIN STUDENT S ON S.ROOM_NO = R.ROOM_NO GROUP BY R.ROOM_NO, R.BLOCK, R.OCCUPIED ORDER BY R.ROOM_NO');
        break;
      case 'department-summary':
        cols = ['Department', 'Students', 'With Room', 'Without Room', 'Avg Year'];
        data = grid('SELECT DEPARTMENT, COUNT(*), SUM(CASE WHEN ROOM_NO IS NOT NULL THEN 1 ELSE 0 END), ' +
          'SUM(CASE WHEN ROOM_NO IS NULL THEN 1 ELSE 0 END), ROUND(AVG(YEAR_OF_STUDY), 1) FROM STUDENT GROUP BY DEPARTMENT ORDER BY 2 DESC, 1');
        break;
      case 'fee-summary':
        cols = ['Fee Type', 'Bills', 'Billed', 'Collected', 'Pending'];
        data = grid('SELECT FEE_TYPE, COUNT(*), ROUND(SUM(AMOUNT), 2), ROUND(SUM(CASE WHEN PAID_DATE IS NOT NULL THEN AMOUNT ELSE 0 END), 2), ' +
          'ROUND(SUM(CASE WHEN PAID_DATE IS NULL THEN AMOUNT ELSE 0 END), 2) FROM FEE GROUP BY FEE_TYPE ORDER BY FEE_TYPE');
        break;
      case 'fee-defaulters': {
        cols = ['Student', 'Reg No', 'Room', 'Fee Type', 'Amount', 'Due Date', 'Days Overdue'];
        data = grid("SELECT S.NAME, S.REG_NO, S.ROOM_NO, F.FEE_TYPE, F.AMOUNT, strftime('%Y-%m-%d', F.DUE_DATE) " +
          'FROM FEE F JOIN STUDENT S ON S.STUDENT_ID = F.STUDENT_ID WHERE F.PAID_DATE IS NULL AND F.DUE_DATE < ' + TODAY + ' ORDER BY F.DUE_DATE, S.NAME');
        const t = new Date(), today = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
        for (const row of data) {
          const [y, m, dd] = String(row[5]).split('-').map(Number);
          row.push(Math.round((today - Date.UTC(y, m - 1, dd)) / 86400000));
        }
        break;
      }
      case 'complaint-summary':
        cols = ['Category', 'Total', 'Open', 'In Progress', 'Resolved'];
        data = grid("SELECT CATEGORY, COUNT(*), SUM(CASE WHEN STATUS = 'Open' THEN 1 ELSE 0 END), " +
          "SUM(CASE WHEN STATUS = 'In Progress' THEN 1 ELSE 0 END), SUM(CASE WHEN STATUS = 'Resolved' THEN 1 ELSE 0 END) " +
          'FROM COMPLAINT GROUP BY CATEGORY ORDER BY 2 DESC, 1');
        break;
      case 'visitor-summary':
        cols = ['Relation', 'Visits', 'Still Inside'];
        data = grid("SELECT IFNULL(RELATION, 'Other'), COUNT(*), SUM(CASE WHEN OUT_TIME IS NULL THEN 1 ELSE 0 END) FROM VISITOR GROUP BY IFNULL(RELATION, 'Other') ORDER BY 2 DESC, 1");
        break;
      case 'inventory-attention':
        cols = ['Room', 'Block', 'Item', 'Qty', 'Condition', 'Last Checked'];
        data = grid("SELECT I.ROOM_NO, R.BLOCK, I.ITEM_NAME, I.QUANTITY, I.ITEM_CONDITION, strftime('%Y-%m-%d', I.LAST_CHECKED) " +
          "FROM INVENTORY I JOIN ROOM R ON R.ROOM_NO = I.ROOM_NO WHERE I.ITEM_CONDITION <> 'Good' ORDER BY I.ROOM_NO, I.ITEM_NAME");
        break;
      case 'list':
        return map('reports', REPORTS.map(([key, title]) => map('key', key, 'title', title)));
      default: throw new ApiException(404, 'Unknown report.');
    }
    return map('title', REPORTS.find(x => x[0] === name)[1], 'columns', cols, 'rows', data);
  }

  // ============================================================ API entry
  async function route(r) {
    const sg = r.seg;                         // sg[0] === 'api'
    const a = sg.length > 1 ? sg[1] : '', m = r.method;

    if (a === 'login' && m === 'POST') return login(r);

    r.s = sessionOf();
    if (!r.s) throw new ApiException(401, 'Please sign in.');
    const admin = r.s.role === 'ADMIN';

    if (a === 'me') return map('username', r.s.user, 'role', r.s.role);
    if (a === 'logout' && m === 'POST') { writeSession(null); return map('ok', true); }
    if (a === 'password' && m === 'POST') return changePassword(r);

    if (m !== 'GET' && !admin) throw new ApiException(403, 'Your account is read-only.');

    switch (a) {
      case 'meta': return meta(r);
      case 'dashboard': return dashboard(admin);
      case 'search': return search((r.q.get('q') || '').trim());
      case 'lookup': return lookup(sg.length > 2 ? sg[2] : '');
      case 'reports': return report(sg.length > 2 ? sg[2] : '');
      case 'users':
        if (!admin) throw new ApiException(403, 'Admins only.');
        return users(r);
      default: break;
    }
    const t = TABLES.get(a);
    if (!t) throw new ApiException(404, 'Unknown resource.');
    if (t.adminOnly && !admin) throw new ApiException(403, 'Admins only.');
    return tableRoute(r, t);
  }

  function parse(method, path, body) {
    const qi = path.indexOf('?');
    const p = qi < 0 ? path : path.substring(0, qi);
    const seg = ['api'];
    for (const part of p.split('/')) if (part) seg.push(decodeURIComponent(part));
    const q = new Map();                       // last value wins, like the Java server
    if (qi >= 0) for (const [k, v] of new URLSearchParams(path.substring(qi + 1))) q.set(k, v);
    let b = {};
    if (body !== undefined && body !== null) {
      b = JSON.parse(JSON.stringify(body));    // same as a trip over the network
      if (typeof b !== 'object' || Array.isArray(b)) throw bad('Expected a JSON object.');
    }
    return { method: (method || 'GET').toUpperCase(), seg, q, body: b, s: null, op: null };
  }

  /** the one entry point: behaves like fetch('/api' + path) and res.json() */
  async function request(method, path, body) {
    try { await ready; }
    catch (e) {
      console.error(e);
      return { ok: false, status: 503, data: { error: 'The in-browser database could not start: ' + (e && e.message || e) } };
    }
    let r;
    try {
      r = parse(method, path, body);
      const data = await route(r);
      if (dirty) await save();
      return { ok: true, status: 200, data };
    } catch (e) {
      if (e instanceof ApiException) return { ok: false, status: e.status, data: { error: e.message } };
      if (isSqlError(e)) { console.warn('SQL error:', e.message); return { ok: false, status: 400, data: { error: friendly(e, r && r.op) } }; }
      console.error(e);
      return { ok: false, status: 500, data: { error: 'Something went wrong in the browser database.' } };
    }
  }

  // ============================================================ database files (account menu)
  async function exportDb() {
    await ready;
    const bytes = db.export();
    afterOpen();
    return bytes;
  }
  function sqlValue(v) {
    if (v == null) return 'NULL';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
    if (v instanceof Uint8Array) return "X'" + hex(v) + "'";
    return "'" + String(v).replace(/'/g, "''") + "'";
  }
  /** a plain SQL dump that sqlite3 (or sql.js) can run to rebuild this database */
  async function exportSql() {
    await ready;
    const objs = grid("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid");
    const tables = objs.filter(o => o[0] === 'table').map(o => o[1]);
    const out = ['-- Hostel Desk database export (SQLite), ' + new Date().toISOString(),
      '-- Rebuild with:  sqlite3 hostel.db < this-file.sql', 'PRAGMA foreign_keys = OFF;', 'BEGIN TRANSACTION;'];
    for (const t of [...tables].reverse()) out.push('DROP TABLE IF EXISTS "' + t + '";');
    for (const [type, name, sql] of objs) {
      out.push('', sql + ';');
      if (type !== 'table') continue;
      const st = db.prepare('SELECT * FROM "' + name + '"');
      try {
        const cols = st.getColumnNames().map(c => '"' + c + '"').join(', ');
        while (st.step()) out.push('INSERT INTO "' + name + '" (' + cols + ') VALUES (' + st.get().map(sqlValue).join(', ') + ');');
      } finally { st.free(); }
    }
    const seqs = num("SELECT COUNT(*) FROM sqlite_master WHERE name = 'sqlite_sequence'") ? grid('SELECT name, seq FROM sqlite_sequence') : [];
    if (seqs.length) {
      out.push('', 'DELETE FROM sqlite_sequence;');
      for (const [n, s] of seqs) out.push('INSERT INTO sqlite_sequence (name, seq) VALUES (' + sqlValue(n) + ', ' + s + ');');
    }
    out.push('', 'COMMIT;', 'PRAGMA foreign_keys = ON;', '');
    return out.join('\n');
  }

  return { request, ready, reset, exportDb, exportSql, storage: () => storage };
})();
