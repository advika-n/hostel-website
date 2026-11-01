// Compares the JSON of the static build's in-browser API (static/api.js) with the
// Java server (HostelServer.java + Oracle) for the same requests on the same data.
//
//   1. start the Java server, e.g.
//        java -cp ".;ojdbc8.jar" HostelServer --db localhost:1521/XEPDB1 --user hostel --pass hostel123 --port 8099
//   2. node tests/compare-java.js [javaUrl] [adminPassword]
//
// It only READS from the Java server (plus requests that are rejected by validation),
// so the Oracle data is not changed, apart from the admin's LAST_LOGIN time.
// Oracle's current rows are copied into a SQLite file that is loaded into the
// browser's IndexedDB, so both sides answer from the same data.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { chromium } = require('playwright');
const initSqlJs = require('sql.js');
const { serve } = require('./serve');

const JAVA = process.argv[2] || 'http://localhost:8099';
const ADMIN_PW = process.argv[3] || 'admin123';
const ROOT = path.join(__dirname, '..', 'static');
const PORT = 8124;

let cookie = '';
async function java(method, p, body) {
  const res = await fetch(JAVA + '/api' + p, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, data };
}

const COPY = {   // api table -> [DB table, columns (same names as the API keys)]
  rooms: ['ROOM', 'room_no block capacity occupied rent'],
  students: ['STUDENT', 'student_id reg_no name phone email department year_of_study guardian_phone room_no join_date'],
  wardens: ['WARDEN', 'warden_id name phone email block shift_time'],
  fees: ['FEE', 'fee_id student_id fee_type amount due_date paid_date pay_mode'],
  complaints: ['COMPLAINT', 'complaint_id student_id category description priority status created_on resolved_on'],
  visitors: ['VISITOR', 'visitor_id student_id visitor_name relation phone in_time out_time'],
  leaves: ['LEAVE_REQUEST', 'leave_id student_id leave_from leave_to reason status applied_on'],
  inventory: ['INVENTORY', 'item_id room_no item_name quantity item_condition last_checked'],
  notices: ['NOTICE', 'notice_id title body priority posted_by posted_on'],
  audit: ['AUDIT_LOG', 'log_id username action table_name detail log_time']
};

function pbkdf2(pw, saltHex) {
  return crypto.pbkdf2Sync(pw, Buffer.from(saltHex, 'hex'), 65536, 32, 'sha256').toString('hex');
}

async function buildDbFromOracle() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  db.exec(schema.split('-- ---------- sample data ----------')[0]);   // tables only
  db.exec('PRAGMA foreign_keys = OFF');
  const counts = {};
  for (const [key, [table, colStr]] of Object.entries(COPY)) {
    const cols = colStr.split(' ');
    const r = await java('GET', '/' + key + '?export=1&size=10000&sort=' + cols[0] + '&dir=asc');
    if (r.status !== 200) throw new Error('Java ' + key + ': ' + JSON.stringify(r.data));
    const st = db.prepare('INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')');
    for (const row of r.data.rows) st.run(cols.map(c => row[c] === undefined ? null : row[c]));
    st.free();
    counts[key] = r.data.rows.length;
  }
  const users = (await java('GET', '/users')).data.rows;
  for (const u of users) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.run('INSERT INTO APP_USER (USERNAME, PASSWORD_HASH, SALT, ROLE, CREATED_ON, LAST_LOGIN) VALUES (?, ?, ?, ?, ?, ?)',
      [u.username, pbkdf2(u.username === 'admin' ? ADMIN_PW : 'not-used-' + salt, salt), salt, u.role, u.created_on, u.last_login]);
  }
  const bytes = db.export();
  db.close();
  return { bytes, counts };
}

// ------------------------------------------------------------ the requests to compare
function requests(meta, busyRoom) {
  const R = [['GET', '/me'], ['GET', '/meta'], ['GET', '/dashboard'], ['GET', '/reports/list']];
  for (const r of ['block-summary', 'room-vacancy', 'room-occupants', 'department-summary', 'fee-summary', 'fee-defaulters', 'complaint-summary', 'visitor-summary', 'inventory-attention', 'nope'])
    R.push(['GET', '/reports/' + r]);
  for (const l of ['rooms', 'students', 'blocks', 'users', 'nope']) R.push(['GET', '/lookup/' + l]);
  for (const q of ['', 'a', 'ro', 'RO', 'a-b', '10', '%', '_', 'wifi', 'zzzz']) R.push(['GET', '/search?q=' + encodeURIComponent(q)]);
  R.push(['GET', '/users']);
  for (const [key, tm] of Object.entries(meta.tables)) {
    const base = '/' + key;
    R.push(['GET', base], ['GET', base + '?page=2&size=5'], ['GET', base + '?page=999&size=10'], ['GET', base + '?size=abc&page=x'],
      ['GET', base + '?size=1000'], ['GET', base + '?export=1&size=5000'], ['GET', base + '?q=a'], ['GET', base + '?q=e&size=100'],
      ['GET', base + '?q=%25'], ['GET', base + '?sort=nope'], ['GET', base + '/1'], ['GET', base + '/999999'], ['GET', base + '/abc']);
    for (const f of tm.fields) {
      for (const dir of ['asc', 'desc']) R.push(['GET', base + '?size=100&sort=' + f.key + '&dir=' + dir]);
      if (f.filter && f.options) for (const o of f.options) R.push(['GET', base + '?size=100&f_' + f.key + '=' + encodeURIComponent(o)]);
      if (f.filter && (f.type === 'int')) R.push(['GET', base + '?size=100&f_' + f.key + '=1'], ['GET', base + '?size=100&f_' + f.key + '=101'], ['GET', base + '?f_' + f.key + '=x']);
      if (f.filter && f.ref === 'blocks') R.push(['GET', base + '?size=100&f_' + f.key + '=A-Block']);
      if (f.range && (f.type === 'date' || f.type === 'datetime')) {
        const d = new Date(), iso = x => new Date(d.getTime() + x * 86400000).toISOString().slice(0, 10);
        R.push(['GET', base + '?size=100&' + f.key + '_min=' + iso(-30)], ['GET', base + '?size=100&' + f.key + '_max=' + iso(-10)],
          ['GET', base + '?size=100&' + f.key + '_min=' + iso(-60) + '&' + f.key + '_max=' + iso(0)], ['GET', base + '?' + f.key + '_min=2025-02-30']);
      } else if (f.range) R.push(['GET', base + '?size=100&' + f.key + '_min=40000'], ['GET', base + '?size=100&' + f.key + '_max=3500.5'], ['GET', base + '?' + f.key + '_min=abc']);
    }
    for (const fl of tm.flags || []) R.push(['GET', base + '?size=100&flag_' + fl.key + '=1']);
    // rejected writes (validation fails before anything is stored)
    if (!tm.readOnly) {
      R.push(['POST', base, {}], ['PUT', base + '/999999', { name: 'x' }], ['DELETE', base + '/999999'], ['PATCH', base]);
    } else R.push(['POST', base, {}], ['PUT', base + '/1', {}], ['DELETE', base + '/1']);
  }
  R.push(
    ['GET', '/nope'], ['POST', '/meta'], ['GET', '/fees/generate'], ['POST', '/fees/1/nope', {}], ['GET', '/students/1/allot'],
    ['POST', '/students', { reg_no: 'bad reg!', name: 'X', department: 'CSE', year_of_study: '1' }],
    ['POST', '/students', { reg_no: 'R1', name: 'X', department: 'Physics', year_of_study: '1' }],
    ['POST', '/students', { reg_no: 'R1', name: 'X', department: 'cse', year_of_study: '9' }],
    ['POST', '/students', { reg_no: 'R1', name: 'X', department: 'cse', year_of_study: '1.5' }],
    ['POST', '/students', { reg_no: 'R1', name: 'X', department: 'cse', year_of_study: '1', email: 'nope' }],
    ['POST', '/students', { reg_no: 'R1', name: 'X', department: 'cse', year_of_study: '1', phone: '12' }],
    ['POST', '/students', { reg_no: 'R1', name: 'X'.repeat(51), department: 'cse', year_of_study: '1' }],
    ['POST', '/students', { reg_no: 'R1', name: 'X', department: 'cse', year_of_study: '1', join_date: '2025-02-30' }],
    ['POST', '/rooms', { room_no: '0', block: 'A', capacity: '1', rent: '1' }],
    ['POST', '/rooms', { room_no: '5', block: 'A', capacity: '1', rent: '1.234' }],
    ['POST', '/rooms', { room_no: '5', block: 'A', capacity: '1', rent: '1000000' }],
    ['POST', '/rooms', { room_no: '101', block: 'A', capacity: '1', rent: '10' }],
    // only on a room with 2+ students, so Oracle rejects them too (capacity < occupied, students still in the room)
    ...(busyRoom ? [['PUT', '/rooms/' + busyRoom, { capacity: '1' }], ['PUT', '/rooms/' + busyRoom, {}], ['DELETE', '/rooms/' + busyRoom]] : []),
    ['POST', '/fees', { student_id: '1', fee_type: 'Mess', amount: '10', due_date: '2026-01-01', paid_date: '2026-01-01' }],
    ['POST', '/fees', { student_id: '1', fee_type: 'Mess', amount: '10', due_date: '2026-01-01', pay_mode: 'upi' }],
    ['POST', '/fees', { student_id: '1', fee_type: 'Mess', amount: '0', due_date: '2026-01-01' }],
    ['POST', '/fees', { student_id: '99999', fee_type: 'Mess', amount: '10', due_date: '2026-01-01' }],
    ['POST', '/visitors', { student_id: '1', visitor_name: 'V', in_time: '2026-01-02T10:00', out_time: '2026-01-01 10:00' }],
    ['POST', '/visitors', { student_id: '1', visitor_name: 'V', in_time: '2026-01-02 25:00' }],
    ['POST', '/leaves', { student_id: '1', leave_from: '2026-01-05', leave_to: '2026-01-01', reason: 'r' }],
    ['POST', '/students/1/allot', {}], ['POST', '/students/1/allot', { room_no: 'abc' }], ['POST', '/students/999999/allot', { room_no: 101 }],
    ['POST', '/students/1/allot', { room_no: 99999 }],
    ['POST', '/students/999999/vacate', {}],
    ['POST', '/fees/1/pay', { pay_mode: 'Cheque' }], ['POST', '/fees/999999/pay', { pay_mode: 'cash' }],
    ['POST', '/complaints/1/status', { status: 'Closed' }], ['POST', '/complaints/999999/status', { status: 'open' }],
    ['POST', '/visitors/999999/checkout', {}],
    ['POST', '/leaves/1/decision', { status: 'Maybe' }], ['POST', '/leaves/999999/decision', { status: 'approved' }],
    ['POST', '/fees/generate', { fee_type: 'Rent' }], ['POST', '/fees/generate', { fee_type: 'mess', due_date: '2026-13-01' }],
    ['POST', '/fees/generate', { fee_type: 'mess', due_date: '2026-12-01', amount: '-5' }],
    ['POST', '/users', { username: 'ab', password: 'secret1', role: 'VIEWER' }],
    ['POST', '/users', { username: 'abc', password: '123', role: 'VIEWER' }],
    ['POST', '/users', { username: 'abc', password: 'secret1', role: 'BOSS' }],
    ['POST', '/users', { username: 'ADMIN', password: 'secret1', role: 'viewer' }],
    ['PUT', '/users/nobody', { role: 'VIEWER' }], ['PUT', '/users/admin', { role: 'BOSS' }], ['DELETE', '/users/admin'], ['DELETE', '/users/nobody'],
    ['PUT', '/users'], ['POST', '/password', { old_password: 'x', new_password: '123' }],
    ['POST', '/password', { old_password: 'wrong-password', new_password: '1234567' }]
  );
  return R;
}

// ------------------------------------------------------------ compare
function diff(a, b, at, out) {
  if (out.length > 6) return;
  if (typeof a === 'number' && typeof b === 'number') { if (Math.abs(a - b) > 1e-9) out.push(at + ': ' + a + ' vs ' + b); return; }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') { if (a !== b) out.push(at + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b)); return; }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(at + ': array vs object'); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(at + ': length ' + a.length + ' vs ' + b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], at + '[' + i + ']', out);
    return;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.join() !== kb.join()) out.push(at + ': keys ' + ka.join(',') + ' vs ' + kb.join(','));
  for (const k of ka) if (k in b) diff(a[k], b[k], at + '.' + k, out);
}

(async () => {
  const login = await java('POST', '/login', { username: 'admin', password: ADMIN_PW });
  if (login.status !== 200) throw new Error('Cannot sign in to the Java server: ' + JSON.stringify(login.data));
  const { bytes, counts } = await buildDbFromOracle();
  const rooms = (await java('GET', '/rooms?export=1&size=10000')).data.rows;
  const busy = rooms.find(r => r.occupied >= 2);
  const students = (await java('GET', '/students?export=1&size=10000')).data.rows;
  if (busy && students.filter(s => s.room_no === busy.room_no).length < 2) throw new Error('room data is inconsistent, not running write checks');
  console.log('Copied from Oracle:', JSON.stringify(counts));

  const srv = await serve(ROOT, PORT);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:' + PORT + '/');
  await page.evaluate(() => HostelAPI.ready);
  await page.evaluate(async arr => {                   // replace the browser's database with the Oracle copy
    const bytes = new Uint8Array(arr);
    await new Promise((resolve, reject) => {
      const rq = indexedDB.open('hostel-desk', 1);
      rq.onsuccess = () => { const tr = rq.result.transaction('files', 'readwrite'); tr.objectStore('files').put(bytes, 'hostel.db'); tr.oncomplete = () => { rq.result.close(); resolve(); }; tr.onerror = () => reject(tr.error); };
      rq.onerror = () => reject(rq.error);
    });
  }, Array.from(bytes));
  await page.reload();
  const js = (method, p, body) => page.evaluate(([m, pp, b]) => HostelAPI.request(m, pp, b).then(r => ({ status: r.status, data: r.data })), [method, p, body]);
  const jl = await js('POST', '/login', { username: 'admin', password: ADMIN_PW });
  if (jl.status !== 200) throw new Error('JS login failed ' + JSON.stringify(jl));

  const meta = (await java('GET', '/meta')).data;
  const list = requests(meta, busy && busy.room_no);
  let same = 0;
  const bad = [];
  for (const [m, p, b] of list) {
    const [a, c] = [await java(m, p, b), await js(m, p, b)];
    const out = [];
    if (a.status !== c.status) out.push('status ' + a.status + ' vs ' + c.status);
    diff(a.data, c.data, '', out);
    if (out.length) bad.push(m + ' ' + p + (b ? ' ' + JSON.stringify(b) : '') + '\n      ' + out.join('\n      '));
    else same++;
  }
  console.log('\nCompared ' + list.length + ' requests (Java vs JS): ' + same + ' identical, ' + bad.length + ' different.');
  for (const x of bad) console.log('  - ' + x);
  await browser.close();
  srv.close();
  process.exitCode = bad.length ? 1 : 0;
})().catch(e => { console.error(e); process.exit(2); });
