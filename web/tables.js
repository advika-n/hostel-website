'use strict';
/* Hostel Desk - generic table pages, row actions and detail drawers. */

const isAdmin = () => H.user && H.user.role === 'ADMIN';
const STATUS_KEYS = new Set(['status', 'priority', 'presence', 'item_condition']);
const MONEY_KEYS = new Set(['rent', 'amount']);

function cellValue(tm, f, row) {
  const v = row[f.key];
  if (f.key === 'name' && tm.key === 'students') return el('button', { class: 'linkcell', type: 'button', text: v, onclick: () => openStudent(row.student_id) });
  if (f.key === 'student_name' && row.student_id != null) return el('button', { class: 'linkcell', type: 'button', text: v || '', onclick: () => openStudent(row.student_id) });
  if (f.key === 'room_no' && tm.key !== 'rooms') return v == null ? dash() : el('button', { class: 'linkcell', type: 'button', text: v, onclick: () => openRoom(v) });
  if (f.key === 'room_no') return el('button', { class: 'linkcell', type: 'button', text: v, onclick: () => openRoom(v) });
  if (v == null || v === '') return dash();
  if (STATUS_KEYS.has(f.key) || (tm.key === 'wardens' && false)) return pill(v);
  if (MONEY_KEYS.has(f.key)) return document.createTextNode(money(v));
  if (f.key === 'occupancy') return document.createTextNode(v + '%');
  if (f.type === 'date') {
    const t = document.createTextNode(fmtDate(v));
    if (tm.key === 'fees' && f.key === 'due_date' && row.status === 'Overdue') return el('span', { class: 'is-bad', text: fmtDate(v) });
    return t;
  }
  if (f.type === 'datetime') return document.createTextNode(fmtDateTime(v));
  return document.createTextNode(String(v));
}
function rawText(f, v) {
  if (v == null) return '';
  if (f.type === 'date') return v;
  return v;
}

/* ---------- row actions ---------- */
async function doAction(promise, msg) {
  try { await promise; if (msg) toast(msg); if (H.refreshPage) H.refreshPage(); return true; }
  catch (e) { fail(e); return false; }
}
async function allotDialog(studentId, name, current) {
  let rooms;
  try { rooms = await lookup('rooms'); } catch (e) { return fail(e); }
  const free = rooms.filter(r => r.free > 0 && r.id !== current);
  if (!free.length) return toast('No room has a free bed right now.', 'bad');
  const sel = el('select', { class: 'select', id: 'allot_room' }, el('option', { value: '', text: 'Choose a room…' }),
    free.map(r => el('option', { value: r.id, text: r.label + ' (' + r.free + ' free)' })));
  const err = el('div', { class: 'banner', role: 'alert', hidden: true });
  openModal({
    title: current ? 'Move ' + name : 'Give ' + name + ' a room',
    body: [err, el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'allot_room', text: 'Room' }), sel)],
    buttons: [
      { label: 'Cancel', onClick: m => m.close() },
      { label: current ? 'Move student' : 'Allot room', kind: 'primary', onClick: async (m, b) => {
        if (!sel.value) { err.textContent = 'Choose a room.'; err.hidden = false; return; }
        b.disabled = true;
        try { await api('/students/' + studentId + '/allot', { method: 'POST', body: { room_no: Number(sel.value) } }); m.close(); toast(name + ' is now in room ' + sel.value + '.'); H.refreshPage && H.refreshPage(); }
        catch (e) { err.textContent = e.message; err.hidden = false; b.disabled = false; }
      } }]
  });
}
async function payDialog(row) {
  const sel = el('select', { class: 'select', id: 'pay_mode' }, ['Cash', 'UPI', 'Card', 'Net Banking'].map(o => el('option', { value: o, text: o })));
  const err = el('div', { class: 'banner', role: 'alert', hidden: true });
  openModal({
    title: 'Record payment',
    body: [err, el('p', { style: 'margin:0', text: row.student_name + ' pays ' + money(row.amount) + ' for ' + row.fee_type + '.' }),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'pay_mode', text: 'Paid by' }), sel)],
    buttons: [
      { label: 'Cancel', onClick: m => m.close() },
      { label: 'Mark as paid', kind: 'primary', onClick: async (m, b) => {
        b.disabled = true;
        try { await api('/fees/' + row.fee_id + '/pay', { method: 'POST', body: { pay_mode: sel.value } }); m.close(); toast('Payment recorded.'); H.refreshPage && H.refreshPage(); }
        catch (e) { err.textContent = e.message; err.hidden = false; b.disabled = false; }
      } }]
  });
}
function generateFeesDialog() {
  const tm = H.meta.fees;
  const type = el('select', { class: 'select', id: 'gf_type' }, el('option', { value: '', text: 'Choose…' }),
    tm.fields.find(f => f.key === 'fee_type').options.map(o => el('option', { value: o, text: o })));
  const rent = el('input', { type: 'checkbox', id: 'gf_rent' });
  const amount = el('input', { class: 'input', id: 'gf_amount', type: 'number', min: '1', step: '0.01' });
  const due = el('input', { class: 'input', id: 'gf_due', type: 'date' });
  const err = el('div', { class: 'banner', role: 'alert', hidden: true });
  rent.addEventListener('change', () => { amount.disabled = rent.checked; if (rent.checked) amount.value = ''; });
  openModal({
    title: 'Generate fees for everyone',
    body: [err,
      el('p', { class: 'muted', style: 'margin:0', text: 'Creates one bill for every student who has a room. Students who already have this bill for the same due date are skipped.' }),
      el('div', { class: 'formgrid' },
        el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'gf_type', text: 'Fee type *' }), type),
        el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'gf_due', text: 'Due date *' }), due),
        el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'gf_amount', text: 'Amount' }), amount),
        el('div', { class: 'field', style: 'align-content:end' }, el('label', { class: 'check' }, rent, 'Use each room\'s rent')))],
    buttons: [
      { label: 'Cancel', onClick: m => m.close() },
      { label: 'Generate', kind: 'primary', onClick: async (m, b) => {
        if (!type.value) { err.textContent = 'Choose a fee type.'; err.hidden = false; return; }
        if (!due.value) { err.textContent = 'Choose a due date.'; err.hidden = false; return; }
        if (!rent.checked && !(Number(amount.value) > 0)) { err.textContent = 'Enter an amount or use each room\'s rent.'; err.hidden = false; return; }
        b.disabled = true;
        try {
          const r = await api('/fees/generate', { method: 'POST', body: { fee_type: type.value, use_room_rent: rent.checked, amount: rent.checked ? null : Number(amount.value), due_date: due.value } });
          m.close();
          toast((r && r.created != null ? r.created + ' bills created' + (r.skipped ? ', ' + r.skipped + ' skipped' : '') : 'Fees generated') + '.');
          H.refreshPage && H.refreshPage();
        } catch (e) { err.textContent = e.message; err.hidden = false; b.disabled = false; }
      } }]
  });
}

function rowActions(tm, row) {
  const k = tm.key, out = [];
  const btn = (label, fn, kind) => el('button', { class: 'btn btn--sm' + (kind ? ' btn--' + kind : ''), type: 'button', text: label, onclick: fn });
  if (!isAdmin() || tm.readOnly) return out;
  if (k === 'students') {
    out.push(btn(row.room_no == null ? 'Allot room' : 'Move', () => allotDialog(row.student_id, row.name, row.room_no)));
    if (row.room_no != null) out.push(btn('Vacate', async () => {
      if (await confirmBox({ title: 'Vacate room?', text: row.name + ' will leave room ' + row.room_no + '.', ok: 'Vacate' }))
        doAction(api('/students/' + row.student_id + '/vacate', { method: 'POST', body: {} }), row.name + ' has left room ' + row.room_no + '.');
    }));
  } else if (k === 'fees' && row.status !== 'Paid') out.push(btn('Record payment', () => payDialog(row), 'primary'));
  else if (k === 'complaints') {
    const set = s => doAction(api('/complaints/' + row.complaint_id + '/status', { method: 'POST', body: { status: s } }), 'Marked ' + s.toLowerCase() + '.');
    if (row.status === 'Open') out.push(btn('Start', () => set('In Progress')));
    if (row.status !== 'Resolved') out.push(btn('Resolve', () => set('Resolved'), 'primary'));
  } else if (k === 'visitors' && row.presence === 'Inside')
    out.push(btn('Check out', () => doAction(api('/visitors/' + row.visitor_id + '/checkout', { method: 'POST', body: {} }), row.visitor_name + ' checked out.')));
  else if (k === 'leaves' && row.status === 'Pending') {
    const dec = s => doAction(api('/leaves/' + row.leave_id + '/decision', { method: 'POST', body: { status: s } }), 'Leave ' + s.toLowerCase() + '.');
    out.push(btn('Approve', () => dec('Approved'), 'primary'), btn('Reject', () => dec('Rejected')));
  }
  out.push(btn('Edit', () => editRecord(tm, row)));
  out.push(btn('Delete', () => deleteRecord(tm, row), 'danger'));
  return out;
}

/* ---------- create / edit / delete ---------- */
async function recordForm(tm, row) {
  const mode = row ? 'edit' : 'create';
  let values = row || {};
  if (row) { try { values = await api('/' + tm.key + '/' + row[tm.pk]); } catch (e) { return fail(e); } }
  let form;
  try { form = await buildForm(tm, values, mode); } catch (e) { return fail(e); }
  const one = tm.title.replace(/s$/, '').replace(/ie$/, 'y');
  openModal({
    title: row ? 'Edit ' + one.toLowerCase() : 'Add ' + one.toLowerCase(), wide: true, body: form.node,
    buttons: [
      { label: 'Cancel', onClick: m => m.close() },
      { label: row ? 'Save changes' : 'Add', kind: 'primary', onClick: async (m, b) => {
        form.clearError();
        if (!form.validate()) return;
        b.disabled = true;
        try {
          await api('/' + tm.key + (row ? '/' + row[tm.pk] : ''), { method: row ? 'PUT' : 'POST', body: form.values() });
          m.close(); toast(row ? 'Changes saved.' : 'Added.'); H.refreshPage && H.refreshPage();
        } catch (e) { form.error(e.message); b.disabled = false; }
      } }]
  });
}
const editRecord = (tm, row) => recordForm(tm, row);
async function deleteRecord(tm, row) {
  const extra = tm.key === 'students' ? ' Their fees, complaints, visitors and leave requests go with them.' : tm.key === 'rooms' ? ' Its inventory goes with it.' : '';
  if (await confirmBox({ title: 'Delete this record?', text: 'This cannot be undone.' + extra, ok: 'Delete', danger: true }))
    doAction(api('/' + tm.key + '/' + row[tm.pk], { method: 'DELETE' }), 'Deleted.');
}

/* ---------- table page ---------- */
const PAGE_SIZES = [10, 25, 50, 100];
const PRESET_YEARS = [1, 2, 3, 4, 5].map(String);

function stateFor(tm, params) {
  const key = tm.key;
  const prev = H.state[key];
  const fresh = !prev || params.toString() !== (prev.hash || '');
  if (!fresh) return prev;
  const s = { hash: params.toString(), q: params.get('q') || '', sort: tm.defaultSort, dir: tm.defaultDir, page: 1, size: (prev && prev.size) || 25, filters: {}, flags: [], ranges: {}, more: false };
  for (const [k, v] of params) {
    if (k.startsWith('f_')) s.filters[k.slice(2)] = v;
    else if (k.startsWith('flag_')) s.flags.push(k.slice(5));
    else if (/_(min|max)$/.test(k)) s.ranges[k] = v;
  }
  H.state[key] = s;
  return s;
}
function queryString(s, extra) {
  const p = new URLSearchParams();
  p.set('sort', s.sort); p.set('dir', s.dir);
  if (s.q) p.set('q', s.q);
  Object.entries(s.filters).forEach(([k, v]) => v !== '' && p.set('f_' + k, v));
  s.flags.forEach(f => p.set('flag_' + f, '1'));
  Object.entries(s.ranges).forEach(([k, v]) => v !== '' && p.set(k, v));
  Object.entries(extra).forEach(([k, v]) => p.set(k, v));
  return p.toString();
}
function activeCount(s) {
  return Object.values(s.filters).filter(Boolean).length + s.flags.length + Object.values(s.ranges).filter(Boolean).length + (s.q ? 1 : 0);
}

async function filterOptions(f) {
  if (f.options) return f.options.map(o => [o, o]);
  if (f.ref) return (await lookup(f.ref)).map(r => [String(r.id), r.label]);
  if (f.key === 'year_of_study') return PRESET_YEARS.map(y => [y, 'Year ' + y]);
  return null;
}

async function renderTable(root, key, params) {
  const tm = H.meta[key];
  const s = stateFor(tm, params);
  const HIDE = { students: ['email', 'block'], inventory: ['block'], complaints: ['resolved_on'], fees: ['reg_no'] };
  const listFields = tm.fields.filter(f => f.list && !(HIDE[key] || []).includes(f.key) && !(f.key === tm.pk && !['rooms', 'audit'].includes(key)));
  const selFields = tm.fields.filter(f => f.filter);
  const optMap = {};
  await Promise.all(selFields.map(async f => { optMap[f.key] = await filterOptions(f); }));
  const rangeFields = tm.fields.filter(f => f.range);
  const textFilters = selFields.filter(f => !optMap[f.key]);
  const selects = selFields.filter(f => optMap[f.key]);
  const inline = selects.slice(0, 3), moreSel = selects.slice(3);
  const canWrite = isAdmin() && !tm.readOnly;

  const head = el('div', { class: 'page__head' }, el('div', {},
    el('h1', { class: 'page__title', text: tm.title }),
    el('p', { class: 'page__sub', id: 'sub_' + key, text: ' ' })));
  const tools = el('div', { class: 'page__tools' });
  tools.append(
    el('button', { class: 'btn', type: 'button', onclick: exportCsv }, icon('download'), ' Export CSV'),
    el('button', { class: 'btn', type: 'button', onclick: () => window.print() }, icon('printer'), ' Print'));
  if (canWrite && key === 'fees') tools.append(el('button', { class: 'btn', type: 'button', text: 'Generate fees', onclick: generateFeesDialog }));
  if (canWrite) tools.append(el('button', { class: 'btn btn--primary', type: 'button', onclick: () => recordForm(tm, null) }, icon('plus'), ' Add ' + tm.title.replace(/s$/, '').replace(/ie$/, 'y').toLowerCase()));
  head.append(tools);

  /* toolbar */
  const search = el('input', { class: 'input', type: 'search', placeholder: 'Search ' + tm.title.toLowerCase(), 'aria-label': 'Search ' + tm.title, value: s.q, autocomplete: 'off' });
  const reloadSoon = debounce(() => { s.page = 1; load(); }, 250);
  search.addEventListener('input', () => { s.q = search.value.trim(); reloadSoon(); syncChips(); });
  const mkSelect = f => {
    const sel = el('select', { class: 'select', 'aria-label': f.label }, el('option', { value: '', text: 'Any ' + f.label.toLowerCase() }),
      optMap[f.key].map(([v, l]) => el('option', { value: v, text: l })));
    sel.value = s.filters[f.key] || '';
    if (sel.value !== (s.filters[f.key] || '')) { sel.append(el('option', { value: s.filters[f.key], text: s.filters[f.key] })); sel.value = s.filters[f.key]; }
    sel.addEventListener('change', () => { s.filters[f.key] = sel.value; s.page = 1; load(); syncChips(); });
    sel.dataset.fkey = f.key;
    return sel;
  };
  const toolbar = el('div', { class: 'toolbar', role: 'search' }, el('div', { class: 'toolbar__search' }, icon('search'), search), inline.map(mkSelect));
  const chipBtns = {};
  (tm.flags || []).forEach(fl => {
    const b = el('button', { class: 'chip', type: 'button', text: fl.label, 'aria-pressed': String(s.flags.includes(fl.key)) });
    b.addEventListener('click', () => {
      const on = s.flags.includes(fl.key);
      s.flags = s.flags.filter(x => x !== fl.key);
      /* the server's flags in one group (e.g. full / empty) exclude each other */
      if (!on) { if (['vacant', 'full', 'empty'].includes(fl.key)) s.flags = s.flags.filter(x => !['vacant', 'full', 'empty'].includes(x)); if (['allotted', 'unallotted'].includes(fl.key)) s.flags = s.flags.filter(x => !['allotted', 'unallotted'].includes(x)); s.flags.push(fl.key); }
      s.page = 1; load(); syncChips();
    });
    chipBtns[fl.key] = b; toolbar.append(b);
  });
  const hasMore = moreSel.length || rangeFields.length || textFilters.length;
  const moreBtn = hasMore ? el('button', { class: 'btn', type: 'button', 'aria-expanded': String(s.more) }, icon('filter'), ' More filters') : null;
  const clearBtn = el('button', { class: 'btn btn--ghost', type: 'button', text: 'Clear filters' });
  if (moreBtn) toolbar.append(moreBtn);
  toolbar.append(clearBtn);

  const more = el('div', { class: 'morefilters', hidden: !s.more });
  const moreInputs = [];
  moreSel.forEach(f => { const c = mkSelect(f); moreInputs.push(c); more.append(el('div', { class: 'field' }, el('label', { class: 'field__label', text: f.label }), c)); });
  textFilters.forEach(f => {
    const inp = el('input', { class: 'input', value: s.filters[f.key] || '', placeholder: f.label });
    inp.addEventListener('input', debounce(() => { s.filters[f.key] = inp.value.trim(); s.page = 1; load(); syncChips(); }, 250));
    moreInputs.push(inp); more.append(el('div', { class: 'field' }, el('label', { class: 'field__label', text: f.label }), inp));
  });
  rangeFields.forEach(f => {
    const type = f.type === 'date' || f.type === 'datetime' ? 'date' : 'number';
    const mk = sfx => {
      const i = el('input', { class: 'input', type, step: f.type === 'num' ? '0.01' : null, 'aria-label': f.label + (sfx === 'min' ? ' from' : ' to'), value: s.ranges[f.key + '_' + sfx] || '' });
      i.addEventListener('input', debounce(() => { s.ranges[f.key + '_' + sfx] = i.value; s.page = 1; load(); syncChips(); }, 300));
      moreInputs.push(i); return i;
    };
    more.append(el('div', { class: 'field' }, el('span', { class: 'field__label', text: f.label }), el('div', { class: 'range' }, mk('min'), el('span', { class: 'muted', text: 'to' }), mk('max'))));
  });
  if (moreBtn) moreBtn.addEventListener('click', () => { s.more = !s.more; more.hidden = !s.more; moreBtn.setAttribute('aria-expanded', String(s.more)); });
  clearBtn.addEventListener('click', () => {
    s.q = ''; s.filters = {}; s.flags = []; s.ranges = {}; s.page = 1; s.hash = '';
    if (location.hash.includes('?')) { history.replaceState(null, '', '#/' + key); }
    renderTable(root, key, new URLSearchParams());
  });
  function syncChips() {
    Object.entries(chipBtns).forEach(([k, b]) => b.setAttribute('aria-pressed', String(s.flags.includes(k))));
    clearBtn.hidden = activeCount(s) === 0;
  }
  syncChips();

  const results = el('div', { 'aria-live': 'polite' });
  const page = el('div', { class: 'page' }, head, toolbar, hasMore ? more : null, results);
  clear(root).append(page);

  let seq = 0;
  async function load() {
    const my = ++seq;
    const tbl = results.querySelector('.tbl');
    if (tbl) tbl.classList.add('tbl--busy');
    let data;
    try { data = await api('/' + key + '?' + queryString(s, { page: s.page, size: s.size })); }
    catch (e) { if (my === seq) { clear(results).append(el('div', { class: 'empty' }, el('p', { class: 'empty__title', text: 'Could not load ' + tm.title.toLowerCase() }), el('p', { class: 'empty__text', text: e.message }), el('button', { class: 'btn', type: 'button', text: 'Try again', onclick: load }))); } return; }
    if (my !== seq) return;
    if (data.page > data.pages && data.pages > 0) { s.page = data.pages; return load(); }
    const sub = $('#sub_' + key);
    if (sub) sub.textContent = data.total + (data.total === 1 ? ' record' : ' records') + (activeCount(s) ? ' match your filters' : ' in total');
    clear(results);
    if (!data.rows.length) {
      const filtered = activeCount(s) > 0;
      results.append(el('div', { class: 'empty' },
        el('p', { class: 'empty__title', text: filtered ? 'Nothing matches those filters' : 'No ' + tm.title.toLowerCase() + ' yet' }),
        el('p', { class: 'empty__text', text: filtered ? 'Try a shorter search or clear the filters.' : (canWrite ? 'Add the first one to get started.' : 'There is nothing to show here yet.') }),
        filtered ? el('button', { class: 'btn', type: 'button', text: 'Clear filters', onclick: () => clearBtn.click() })
          : canWrite ? el('button', { class: 'btn btn--primary', type: 'button', text: 'Add ' + tm.title.replace(/s$/, '').replace(/ie$/, 'y').toLowerCase(), onclick: () => recordForm(tm, null) }) : null));
      return;
    }
    if (key === 'notices') results.append(noticeBoard(tm, data.rows, canWrite));
    else results.append(el('div', { class: 'tablewrap' }, buildTable(tm, listFields, data.rows, canWrite)));
    results.append(footer(data));
  }
  function buildTable(tm, cols, rows, canWrite) {
    const tr = el('tr');
    cols.forEach(f => {
      const num = (f.type === 'int' || f.type === 'num') && f.key !== 'room_no' && !/_id$/.test(f.key);
      const th = el('th', { scope: 'col', class: 'is-sortable' + (num ? ' is-num' : ''), tabindex: '0', 'aria-sort': s.sort === f.key ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
        f.label, el('span', { class: 'sortmark', 'aria-hidden': 'true', text: s.sort === f.key ? (s.dir === 'asc' ? '▲' : '▼') : '' }));
      const go = () => { if (s.sort === f.key) s.dir = s.dir === 'asc' ? 'desc' : 'asc'; else { s.sort = f.key; s.dir = 'asc'; } s.page = 1; renderHeaderAndLoad(); };
      th.addEventListener('click', go);
      th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      tr.append(th);
    });
    const hasAct = canWrite;
    if (hasAct) tr.append(el('th', { scope: 'col', class: 'is-act' }, el('span', { class: 'sr-only', text: 'Actions' })));
    const body = el('tbody');
    rows.forEach(row => {
      const r = el('tr');
      cols.forEach(f => {
        const num = (f.type === 'int' || f.type === 'num') && f.key !== 'room_no' && !/_id$/.test(f.key);
        r.append(el('td', { class: (num ? 'is-num ' : '') + (f.type === 'text' ? 'is-clip' : ''), title: f.type === 'text' ? row[f.key] : null }, cellValue(tm, f, row)));
      });
      if (hasAct) r.append(el('td', { class: 'is-act' }, rowActions(tm, row)));
      body.append(r);
    });
    return el('table', { class: 'tbl' }, el('caption', { class: 'sr-only', text: tm.title }), el('thead', {}, tr), body);
  }
  function renderHeaderAndLoad() { load(); }
  function footer(data) {
    const size = el('select', { class: 'select', 'aria-label': 'Rows per page' }, PAGE_SIZES.map(n => el('option', { value: n, text: n + ' per page' })));
    size.value = String(s.size);
    size.addEventListener('change', () => { s.size = +size.value; s.page = 1; load(); });
    const from = (data.page - 1) * data.size + 1, to = Math.min(data.total, data.page * data.size);
    const pager = el('nav', { class: 'pager', 'aria-label': 'Pages' });
    const pb = (label, p, cur, dis, aria) => {
      const b = el('button', { type: 'button', text: label, 'aria-label': aria || null, 'aria-current': cur ? 'page' : null, disabled: dis });
      b.addEventListener('click', () => { s.page = p; load(); });
      return b;
    };
    pager.append(pb('‹', data.page - 1, false, data.page <= 1, 'Previous page'));
    const pages = new Set([1, data.pages, data.page - 1, data.page, data.page + 1]);
    let last = 0;
    [...pages].filter(p => p >= 1 && p <= data.pages).sort((a, b) => a - b).forEach(p => {
      if (p - last > 1) pager.append(el('span', { class: 'muted', text: '…', style: 'align-self:center' }));
      pager.append(pb(String(p), p, p === data.page, false, 'Page ' + p)); last = p;
    });
    pager.append(pb('›', data.page + 1, false, data.page >= data.pages, 'Next page'));
    return el('div', { class: 'tablefoot' }, el('span', { class: 'tablefoot__info', text: 'Showing ' + from + '–' + to + ' of ' + data.total }), size, data.pages > 1 ? pager : null);
  }
  async function exportCsv() {
    try {
      const d = await api('/' + key + '?' + queryString(s, { export: 1, size: 5000, page: 1 }));
      downloadCsv(key + '-' + stamp() + '.csv', listFields.map(f => f.label), d.rows.map(r => listFields.map(f => rawText(f, r[f.key]))));
      toast('Exported ' + d.rows.length + ' rows.');
    } catch (e) { fail(e); }
  }
  H.refreshPage = load;
  await load();
}

function noticeBoard(tm, rows, canWrite) {
  return el('div', { class: 'boardgrid' }, rows.map(n => {
    const acts = canWrite ? el('span', { style: 'margin-left:auto;display:flex;gap:6px' },
      el('button', { class: 'btn btn--sm', type: 'button', text: 'Edit', onclick: () => editRecord(tm, n) }),
      el('button', { class: 'btn btn--sm btn--danger', type: 'button', text: 'Delete', onclick: () => deleteRecord(tm, n) })) : null;
    return el('article', { class: 'note note--' + n.priority },
      el('h3', { class: 'note__title', text: n.title }),
      el('p', { class: 'note__body', text: n.body }),
      el('div', { class: 'note__meta' }, pill(n.priority), el('span', { text: fmtDate(n.posted_on) + ' by ' + (n.posted_by || 'staff') }), acts));
  }));
}

/* ---------- detail drawers ---------- */
function kv(pairs) {
  const dl = el('dl', { class: 'kv' });
  pairs.forEach(([k, v]) => { dl.append(el('dt', { text: k }), el('dd', {}, v == null || v === '' ? dash() : (v.nodeType ? v : String(v)))); });
  return dl;
}
function miniList(rows, render, empty) {
  return rows.length ? el('div', { class: 'list' }, rows.map(render)) : el('p', { class: 'muted', style: 'margin:4px 0 0', text: empty });
}
function section(title, ...kids) { return el('section', { class: 'drawer__sec' }, el('h3', { text: title }), ...kids); }

async function openStudent(id) {
  const d = openDrawer({ title: 'Student', sub: 'Loading…' });
  try {
    const q = '?size=100&f_student_id=' + id;
    const [s, fees, comps, vis, leaves] = await Promise.all([api('/students/' + id), api('/fees' + q + '&sort=due_date&dir=desc'), api('/complaints' + q), api('/visitors' + q), api('/leaves' + q)]);
    d.drawer.querySelector('.drawer__title').textContent = s.name;
    d.drawer.querySelector('.drawer__sub').textContent = s.reg_no + ' - ' + s.department + ', year ' + s.year_of_study;
    const owed = fees.rows.filter(f => f.status !== 'Paid').reduce((a, f) => a + Number(f.amount), 0);
    const actions = el('div', { class: 'drawer__actions' });
    if (isAdmin()) {
      actions.append(el('button', { class: 'btn btn--sm', type: 'button', text: s.room_no == null ? 'Allot room' : 'Move to another room', onclick: () => allotDialog(s.student_id, s.name, s.room_no) }),
        el('button', { class: 'btn btn--sm', type: 'button', text: 'Edit details', onclick: () => { d.close(); recordForm(H.meta.students, s); } }));
    }
    clear(d.body).append(
      kv([['Room', s.room_no == null ? 'Not allotted' : el('button', { class: 'linkcell', type: 'button', text: s.room_no + ' (' + s.block + ')', onclick: () => { d.close(); openRoom(s.room_no); } })],
        ['Phone', s.phone], ['Email', s.email], ['Guardian', s.guardian_phone], ['Joined', fmtDate(s.join_date)],
        ['Fees due', owed ? el('span', { class: 'is-bad', text: money(owed) }) : 'Nothing due']]),
      actions.childNodes.length ? actions : null,
      section('Fees', miniList(fees.rows, f => el('div', { class: 'list__row' }, el('div', { class: 'list__main' }, el('div', { class: 'list__title', text: f.fee_type + ' - ' + money(f.amount) }), el('div', { class: 'list__sub', text: 'Due ' + fmtDate(f.due_date) })), pill(f.status)), 'No fees.')),
      section('Complaints', miniList(comps.rows, c => el('div', { class: 'list__row' }, el('div', { class: 'list__main' }, el('div', { class: 'list__title', text: c.category }), el('div', { class: 'list__sub', text: c.description })), pill(c.status)), 'No complaints.')),
      section('Visitors', miniList(vis.rows, v => el('div', { class: 'list__row' }, el('div', { class: 'list__main' }, el('div', { class: 'list__title', text: v.visitor_name }), el('div', { class: 'list__sub', text: (v.relation || '') + ' - ' + fmtDateTime(v.in_time) })), pill(v.presence)), 'No visitors.')),
      section('Leave requests', miniList(leaves.rows, l => el('div', { class: 'list__row' }, el('div', { class: 'list__main' }, el('div', { class: 'list__title', text: fmtDate(l.leave_from) + ' to ' + fmtDate(l.leave_to) }), el('div', { class: 'list__sub', text: l.reason })), pill(l.status)), 'No leave requests.')));
  } catch (e) { d.close(); fail(e); }
}
async function openRoom(no) {
  const d = openDrawer({ title: 'Room ' + no, sub: 'Loading…' });
  try {
    const [r, studs, inv] = await Promise.all([api('/rooms/' + no), api('/students?size=50&f_room_no=' + no), api('/inventory?size=100&sort=item_name&dir=asc&f_room_no=' + no)]);
    d.drawer.querySelector('.drawer__sub').textContent = r.block + ' - ' + r.occupied + ' of ' + r.capacity + ' beds taken';
    clear(d.body).append(
      kv([['Rent', money(r.rent)], ['Free beds', r.vacant], ['Occupancy', r.occupancy + '%']]),
      isAdmin() ? el('div', { class: 'drawer__actions' }, el('button', { class: 'btn btn--sm', type: 'button', text: 'Edit room', onclick: () => { d.close(); recordForm(H.meta.rooms, r); } })) : null,
      section('Staying here', miniList(studs.rows, s => el('div', { class: 'list__row' }, el('div', { class: 'list__main' }, el('button', { class: 'list__link', type: 'button', text: s.name, onclick: () => { d.close(); openStudent(s.student_id); } }), el('div', { class: 'list__sub', text: s.reg_no + ' - ' + s.department })), el('span', { class: 'muted', text: 'Year ' + s.year_of_study })), 'Nobody yet.')),
      section('Inventory', miniList(inv.rows, i => el('div', { class: 'list__row' }, el('div', { class: 'list__main' }, el('div', { class: 'list__title', text: i.item_name }), el('div', { class: 'list__sub', text: 'Quantity ' + i.quantity + (i.last_checked ? ', checked ' + fmtDate(i.last_checked) : '') })), pill(i.item_condition)), 'No items recorded.')));
  } catch (e) { d.close(); fail(e); }
}
