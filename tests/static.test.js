// End-to-end test of the static build (static/) in a real browser.
//   npm test        (or: node tests/static.test.js [--headed])
const fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const initSqlJs = require('sql.js');
const { serve } = require('./serve');

const ROOT = path.join(__dirname, '..', 'static');
const PORT = 8125, URL = 'http://localhost:' + PORT + '/';
const problems = [];
let page, context, browser, passed = 0, failed = 0;

async function step(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n        ')); }
}
function watch(p) {
  p.on('pageerror', e => problems.push('page error: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
}
const api = (p, opts) => page.evaluate(([pp, o]) => api(pp, o).then(d => d, e => ({ error: e.message, status: e.status })), [p, opts]);
const clearToasts = () => page.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
async function toast(text) {           // waits for the toast, then clears all toasts so an old one never matches the next wait
  await page.locator('.toast', { hasText: text }).first().waitFor({ timeout: 8000 });
  await clearToasts();
}
async function login(user, pw) {
  await page.waitForSelector('#lu');
  await page.fill('#lu', user);
  await page.fill('#lp', pw);
  await page.click('form.login__card button[type=submit]');
}
async function go(hash) {
  await clearToasts();
  await page.evaluate(h => { location.hash = h; }, hash);
  await page.waitForTimeout(150);
  await page.waitForSelector('#view .page');
}
async function fillForm(table, values) {
  for (const [k, v] of Object.entries(values)) {
    const sel = '#f_' + table + '_' + k;
    const tag = await page.$eval(sel, n => n.tagName);
    if (tag === 'SELECT') await page.selectOption(sel, String(v)); else await page.fill(sel, String(v));
  }
}
const modalButton = label => page.locator('.modal__foot button', { hasText: label });
async function openMenu(item) {
  await page.click('.me__btn');
  await page.locator('.menu__item', { hasText: item }).click();
}
async function search(text) {
  await page.fill('.toolbar__search input', text);
  await page.waitForTimeout(450);
}
const row = text => page.locator('.tbl tbody tr', { hasText: text });

// one record per table: what to type when adding, what to change when editing, how to find it again
const CRUD = {
  rooms: { add: { room_no: 909, block: 'D-Block', capacity: 2, rent: 5000 }, find: '909', edit: { rent: 5500 }, after: '₹5,500' },
  students: { add: { reg_no: '26ZED0001', name: 'Zed Tester', department: 'CSE', year_of_study: 1, phone: '9000000001', email: 'zed@example.edu' }, find: 'Zed Tester', edit: { name: 'Zed Tester Two' }, after: 'Zed Tester Two' },
  wardens: { add: { name: 'Zed Warden', phone: '9000000002', block: 'A-Block', shift_time: 'Night' }, find: 'Zed Warden', edit: { name: 'Zed Warden II' }, after: 'Zed Warden II' },
  fees: { add: { student_id: 1, fee_type: 'Fine', amount: 777, due_date: '2099-12-31' }, find: 'Aarav', rowText: '₹777', edit: { amount: 778 }, after: '₹778' },
  complaints: { add: { student_id: 1, category: 'Internet', description: 'Zed router blinking', priority: 'High' }, find: 'Zed router', edit: { description: 'Zed router replaced' }, after: 'Zed router replaced' },
  visitors: { add: { student_id: 1, visitor_name: 'Zed Visitor', relation: 'Friend', phone: '9000000003' }, find: 'Zed Visitor', edit: { visitor_name: 'Zed Visitor B' }, after: 'Zed Visitor B' },
  leaves: { add: { student_id: 1, leave_from: '2099-01-01', leave_to: '2099-01-05', reason: 'Zed trip' }, find: 'Zed trip', edit: { reason: 'Zed trip extended' }, after: 'Zed trip extended' },
  inventory: { add: { room_no: 103, item_name: 'Zed Lamp', quantity: 2, item_condition: 'Good' }, find: 'Zed Lamp', edit: { item_condition: 'Damaged' }, after: 'Damaged' },
  notices: { add: { title: 'Zed notice', body: 'Hello from the test', priority: 'Urgent' }, find: 'Zed notice', edit: { title: 'Zed notice edited' }, after: 'Zed notice edited', board: true }
};

(async () => {
  const headed = process.argv.includes('--headed');
  const srv = await serve(ROOT, PORT);
  browser = await chromium.launch({ headless: !headed });
  context = await browser.newContext({ acceptDownloads: true });
  page = await context.newPage();
  watch(page);
  console.log('Static build test, ' + URL);

  await step('login screen shows the demo notice, wrong password is refused', async () => {
    await page.goto(URL);
    await page.waitForSelector('.login__card');
    assert.match(await page.textContent('.login__card'), /stored only in this browser/);
    await login('admin', 'nope');
    await page.locator('.login__card .banner', { hasText: 'Wrong username or password.' }).waitFor();
  });

  await step('sign in as admin and see the dashboard', async () => {
    await login('admin', 'admin123');
    await page.waitForSelector('.nav__link');
    await page.waitForFunction(() => /Occupancy/.test(document.querySelector('#view').textContent));
    const t = await page.textContent('#view');
    assert.match(t, /14 students across 7 rooms/);
    assert.match(t, /12 of 21 beds/);
    assert.match(t, /Room map/);
    const d = await api('/dashboard');
    assert.strictEqual(d.kpis.students, 14);
    assert.strictEqual(d.kpis.fees_overdue_count, 8);
    assert.strictEqual(d.collection_by_month.length, 6);
    await page.waitForFunction(() => document.querySelector('[data-badge=complaints]') && document.querySelector('[data-badge=complaints]').textContent === '5');
  });

  for (const [table, spec] of Object.entries(CRUD)) {
    await step('add, edit and delete a record: ' + table, async () => {
      await go('#/' + table);
      const before = (await api('/' + table + '?size=1')).total;
      await page.click('.page__tools .btn--primary');
      await page.waitForSelector('.modal');
      await fillForm(table, spec.add);
      await modalButton(/^Add$/).click();
      await toast('Added.');
      assert.strictEqual((await api('/' + table + '?size=1')).total, before + 1);

      await search(spec.find);
      const item = spec.board ? page.locator('article.note', { hasText: spec.find }) : row(spec.rowText || spec.find);
      await item.first().waitFor();
      await item.first().locator('button', { hasText: 'Edit' }).click();
      await page.waitForSelector('.modal');
      await fillForm(table, spec.edit);
      await modalButton('Save changes').click();
      await toast('Changes saved.');

      const edited = spec.board ? page.locator('article.note', { hasText: spec.after }) : row(spec.after);
      await edited.first().waitFor();
      await edited.first().locator('button', { hasText: 'Delete' }).click();
      await modalButton('Delete').click();
      await toast('Deleted.');
      assert.strictEqual((await api('/' + table + '?size=1')).total, before);
    });
  }

  await step('form errors come back from the API in the dialog', async () => {
    await go('#/students');
    await page.click('.page__tools .btn--primary');
    await fillForm('students', { reg_no: '24BCE1001', name: 'Copy Cat', department: 'IT', year_of_study: 2 });
    await modalButton(/^Add$/).click();
    await page.locator('.modal .banner', { hasText: 'A record with the same unique value already exists.' }).waitFor();
    await fillForm('students', { reg_no: '26ZED0002', email: 'not-an-email' });
    await modalButton(/^Add$/).click();
    await page.locator('.modal .banner', { hasText: 'Enter a valid email address.' }).waitFor();
    await page.keyboard.press('Escape');
    const room = await api('/rooms/101', { method: 'PUT', body: { capacity: '2' } });
    assert.strictEqual(room.error, 'Capacity cannot be less than the 3 students already in this room.');
    const del = await api('/rooms/101', { method: 'DELETE' });
    assert.strictEqual(del.error, 'This record is still used by other records, so it cannot be deleted.');
    const lv = await api('/leaves', { method: 'POST', body: { student_id: '1', leave_from: '2026-02-02', leave_to: '2026-02-01', reason: 'x' } });
    assert.strictEqual(lv.error, 'Leave end date cannot be before the start date.');
  });

  await step('allot, move and vacate a student', async () => {
    await go('#/students');
    await search('Dev Patel');
    await row('Dev Patel').locator('button', { hasText: 'Allot room' }).click();
    await page.selectOption('#allot_room', '103');
    await modalButton('Allot room').click();
    await toast('Dev Patel is now in room 103.');
    assert.strictEqual((await api('/rooms/103')).occupied, 1);

    await row('Dev Patel').locator('button', { hasText: 'Move' }).click();
    await page.selectOption('#allot_room', '301');
    await modalButton('Move student').click();
    await toast('Dev Patel is now in room 301.');
    assert.strictEqual((await api('/rooms/103')).occupied, 0);
    assert.strictEqual((await api('/rooms/301')).occupied, 1);

    await row('Dev Patel').locator('button', { hasText: 'Vacate' }).click();
    await modalButton('Vacate').click();
    await toast('Dev Patel has left room 301.');
    assert.strictEqual((await api('/rooms/301')).occupied, 0);
    assert.strictEqual((await api('/students/13')).room_no, null);
    const full = await api('/students/13/allot', { method: 'POST', body: { room_no: 101 } });
    assert.deepStrictEqual(full, { error: 'Room 101 is full.', status: 409 });
  });

  await step('record a fee payment', async () => {
    await go('#/fees?f_status=Overdue');
    const first = page.locator('.tbl tbody tr').first();
    const who = (await first.locator('td').first().textContent()).trim();
    const overdue = (await api('/dashboard')).kpis.fees_overdue_count;
    await first.locator('button', { hasText: 'Record payment' }).click();
    await page.selectOption('#pay_mode', 'UPI');
    await modalButton('Mark as paid').click();
    await toast('Payment recorded.');
    assert.strictEqual((await api('/dashboard')).kpis.fees_overdue_count, overdue - 1);
    const paid = await api('/fees?f_pay_mode=UPI&paid_date_min=' + new Date(Date.now() - 864e5 * 2).toISOString().slice(0, 10) + '&size=100');
    assert.ok(paid.rows.some(r => r.student_name === who && r.status === 'Paid'), 'paid fee for ' + who);
  });

  await step('generate fees for everyone (fixed amount, room rent, repeat skips)', async () => {
    await go('#/fees');
    const gen = async (type, due, amount) => {
      await page.locator('.page__tools button', { hasText: 'Generate fees' }).click();
      await page.selectOption('#gf_type', type);
      await page.fill('#gf_due', due);
      if (amount) await page.fill('#gf_amount', String(amount)); else await page.check('#gf_rent');
      await modalButton('Generate').click();
    };
    await gen('Mess', '2099-02-01', 3500);
    await toast('12 bills created.');
    await gen('Room Rent', '2099-02-01');
    await toast('12 bills created.');
    await gen('Room Rent', '2099-02-01');
    await toast('0 bills created.');
    const rent = await api('/fees?f_fee_type=Room Rent&due_date_min=2099-02-01&size=100');
    assert.strictEqual(rent.total, 12);
    assert.ok(rent.rows.some(r => r.amount === 60000) && rent.rows.some(r => r.amount === 35000));
  });

  await step('complaint status, visitor check-out, leave decision', async () => {
    await go('#/complaints?f_status=Open');
    let n = (await api('/complaints?f_status=Open')).total;
    await page.locator('.tbl tbody tr').first().locator('button', { hasText: 'Start' }).click();
    await toast('Marked in progress.');
    await page.locator('.tbl tbody tr').first().locator('button', { hasText: 'Resolve' }).click();
    await toast('Marked resolved.');
    assert.strictEqual((await api('/complaints?f_status=Open')).total, n - 2);
    await go('#/visitors?f_presence=Inside');
    await page.locator('.tbl tbody tr').first().locator('button', { hasText: 'Check out' }).click();
    await toast('checked out.');
    await go('#/leaves?f_status=Pending');
    await page.locator('.tbl tbody tr').first().locator('button', { hasText: 'Approve' }).click();
    await toast('Leave approved.');
    assert.strictEqual((await api('/leaves?f_status=Pending')).total, 1);
    const again = await api('/leaves/2/decision', { method: 'POST', body: { status: 'Rejected' } });   // #2 is already approved
    assert.deepStrictEqual(again, { error: 'This request was already decided (or does not exist).', status: 409 });
  });

  await step('run all 9 reports', async () => {
    await go('#/reports');
    const buttons = page.locator('.reportlist button');
    assert.strictEqual(await buttons.count(), 9);
    for (let i = 0; i < 9; i++) {
      const b = buttons.nth(i), title = (await b.textContent()).trim();
      await b.click();
      await page.locator('.panel__title', { hasText: title }).waitFor();
      const rows = await page.locator('.reports .tbl tbody tr').count();
      const nothing = await page.locator('.reports', { hasText: 'Nothing to report yet.' }).count();
      assert.ok(rows > 0 || nothing > 0, title);
    }
    const occ = await api('/reports/room-occupants');
    assert.deepStrictEqual(occ.rows[0], [101, 'A-Block', 3, 'Aarav Menon, Karthik Raj, Rohan Iyer']);
  });

  await step('export CSV (table and report)', async () => {
    await go('#/students');
    await search('');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.page__tools button', { hasText: 'Export CSV' }).click()]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    assert.ok(dl.suggestedFilename().startsWith('students-'));
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    assert.strictEqual(lines[0], 'Reg No,Name,Department,Year,Phone,Room,Joined');
    assert.strictEqual(lines.length, 15);
    await go('#/reports?r=fee-summary');
    await page.locator('.panel__title', { hasText: 'Fee summary by type' }).waitFor();
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.locator('.page__tools button', { hasText: 'Export CSV' }).click()]);
    assert.match(fs.readFileSync(await dl2.path(), 'utf8'), /Fee Type,Bills,Billed,Collected,Pending/);
  });

  await step('global search opens a student', async () => {
    await page.fill('.gsearch__input', 'Aarav');
    await page.locator('.results__item', { hasText: 'Aarav Menon' }).waitFor();
    await page.keyboard.press('Enter');
    await page.locator('.drawer__title', { hasText: 'Aarav Menon' }).waitFor();
    await page.keyboard.press('Escape');
  });

  let snapshot;
  await step('download the database (.db) and export SQL from the account menu', async () => {
    snapshot = { fees: (await api('/fees?size=1')).total, audit: (await api('/audit?size=1')).total, dev: (await api('/students/13')).room_no };
    const SQL = await initSqlJs();
    const [d1] = await Promise.all([page.waitForEvent('download'), openMenu('Download database (.db)')]);
    assert.match(d1.suggestedFilename(), /^hostel-desk-\d{4}-\d{2}-\d{2}\.db$/);
    const db = new SQL.Database(fs.readFileSync(await d1.path()));
    assert.strictEqual(db.exec('SELECT COUNT(*) FROM FEE')[0].values[0][0], snapshot.fees);
    db.close();
    const [d2] = await Promise.all([page.waitForEvent('download'), openMenu('Export SQL')]);
    assert.match(d2.suggestedFilename(), /\.sql$/);
    const db2 = new SQL.Database();
    db2.exec(fs.readFileSync(await d2.path(), 'utf8'));
    assert.strictEqual(db2.exec('SELECT COUNT(*) FROM FEE')[0].values[0][0], snapshot.fees);
    assert.strictEqual(db2.exec('SELECT COUNT(*) FROM AUDIT_LOG')[0].values[0][0], snapshot.audit);
    assert.strictEqual(db2.exec("SELECT seq FROM sqlite_sequence WHERE name = 'FEE'")[0].values[0][0] >= snapshot.fees, true);
    assert.deepStrictEqual(db2.exec('PRAGMA foreign_key_check'), []);
    db2.close();
  });

  await step('reload: still signed in and every change is still there', async () => {
    await page.reload();
    await page.waitForSelector('.nav__link');
    assert.strictEqual((await api('/fees?size=1')).total, snapshot.fees);
    assert.strictEqual((await api('/audit?size=1')).total, snapshot.audit);
    const actions = (await api('/audit?size=100')).rows.map(r => r.action);
    for (const a of ['CREATE', 'UPDATE', 'DELETE', 'ALLOT', 'VACATE', 'PAY', 'GENERATE', 'STATUS', 'CHECKOUT', 'DECISION']) assert.ok(actions.includes(a), a);
  });

  await step('a new tab needs a new sign-in but sees the same data', async () => {
    const p2 = await context.newPage();
    watch(p2);
    const old = page;
    page = p2;
    await page.goto(URL);
    await login('admin', 'admin123');
    await page.waitForSelector('.nav__link');
    assert.strictEqual((await api('/fees?size=1')).total, snapshot.fees);
    await p2.close();
    page = old;
  });

  await step('viewer role: can look, cannot change', async () => {
    await go('#/users');
    await page.locator('.page__tools button', { hasText: 'Add user' }).click();
    await page.fill('#nu', 'viewer1');
    await page.fill('#np', 'viewer123');
    await page.selectOption('#nr', 'VIEWER');
    await modalButton('Add user').click();
    await toast('User added.');
    await openMenu('Sign out');
    await login('viewer1', 'viewer123');
    await page.waitForSelector('.nav__link');
    assert.strictEqual(await page.locator('.nav__link[data-route=audit]').count(), 0);
    await go('#/rooms');
    assert.strictEqual(await page.locator('.page__tools .btn--primary').count(), 0);
    assert.strictEqual(await page.locator('.tbl button', { hasText: 'Delete' }).count(), 0);
    await page.click('.me__btn');
    assert.strictEqual(await page.locator('.menu__item', { hasText: 'Reset to sample data' }).count(), 0);
    assert.strictEqual(await page.locator('.menu__item', { hasText: 'Download database' }).count(), 1);
    await page.click('.me__btn');
    assert.deepStrictEqual(await api('/rooms', { method: 'POST', body: {} }), { error: 'Your account is read-only.', status: 403 });
    assert.strictEqual((await api('/audit')).status, 403);
    await openMenu('Sign out');
  });

  await step('change password, then the old one stops working', async () => {
    await login('admin', 'admin123');
    await page.waitForSelector('.nav__link');
    await openMenu('Change password');
    await page.fill('#cp_old', 'admin123');
    await page.fill('#cp_new', 'admin456');
    await page.fill('#cp_con', 'admin456');
    await modalButton('Change password').click();
    await toast('Password changed.');
    await openMenu('Sign out');
    await login('admin', 'admin123');
    await page.locator('.login__card .banner', { hasText: 'Wrong username or password.' }).waitFor();
    await login('admin', 'admin456');
    await page.waitForSelector('.nav__link');
  });

  await step('too many wrong passwords lock the name for a while', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await api('/login', { method: 'POST', body: { username: 'ghost', password: 'x' } });
    assert.deepStrictEqual(last, { error: 'Too many failed attempts. Try again in a few minutes.', status: 429 });
  });

  await step('reset to sample data from the account menu', async () => {
    await openMenu('Reset to sample data');
    await Promise.all([page.waitForEvent('load'), modalButton('Reset').click()]);
    try { await page.waitForSelector('.nav__link', { timeout: 10000 }); }
    catch (e) {
      throw new Error('after reset: ' + JSON.stringify(await page.evaluate(() => ({ root: document.querySelector('#root').textContent.slice(0, 200),
        session: sessionStorage.getItem('hd-session'), toasts: document.querySelector('#toasts').textContent, url: location.href }))));
    }
    assert.strictEqual((await api('/fees?size=1')).total, 38);
    assert.strictEqual((await api('/audit?size=1')).total, 0);
    assert.strictEqual((await api('/students/13')).room_no, null);
    assert.deepStrictEqual((await api('/users')).rows.map(u => u.username), ['admin']);
    await openMenu('Sign out');
    await login('admin', 'admin123');
    await page.waitForSelector('.nav__link');
  });

  await step('when IndexedDB is blocked it still works, in memory', async () => {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: undefined }); });
    const old = page;
    page = await ctx.newPage();
    watch(page);
    await page.goto(URL);
    await page.waitForSelector('.login__card');
    assert.match(await page.textContent('.login__card'), /blocking storage/);
    await login('admin', 'admin123');
    await page.waitForSelector('.nav__link');
    const r = await api('/notices', { method: 'POST', body: { title: 'Memory only', body: 'x' } });
    assert.strictEqual(r.ok, true);
    await ctx.close();
    page = old;
  });

  await step('no JavaScript errors or CSP violations', async () => {
    assert.deepStrictEqual(problems, []);
  });

  await browser.close();
  srv.close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exit(2); });
