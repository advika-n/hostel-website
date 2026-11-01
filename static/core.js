'use strict';
/* Hostel Desk - shared helpers: DOM, API, formatting, dialogs, forms. */

const H = { user: null, meta: null, state: {}, kpis: null, refreshPage: null };
const $ = (s, r) => (r || document).querySelector(s);

/* ---------- DOM builder (text is always inserted as text, never as HTML) ---------- */
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }

/* ---------- icons ---------- */
const ICONS = {
  dashboard: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  rooms: 'M6 3h12v18H6zM3 21h18M14.5 12h.01',
  students: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11a2.5 2.5 0 100-5M18 14.2c1.7.7 3 2.4 3 4.8',
  wardens: 'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6zM9.5 12l1.7 1.7 3.3-3.4',
  inventory: 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8',
  fees: 'M3 7h15a3 3 0 013 3v8a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 7l11-3v3M16.5 14h.01',
  complaints: 'M4 5h16v11H9l-5 4zM12 8.5v3M12 13.5h.01',
  visitors: 'M3 4h9v16H3zM8 12h.01M15 12h6M18 9l3 3-3 3',
  leaves: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  notices: 'M5 4h14v12H5zM9 20l3-4 3 4M9 8h6M9 11h4',
  reports: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  audit: 'M12 7v5l3 2M21 12a9 9 0 11-3-6.7M21 4v4h-4',
  users: 'M8 15a4 4 0 110-8 4 4 0 010 8zM11 12h10M18 12v3M21 12v2',
  search: 'M11 18a7 7 0 110-14 7 7 0 010 14zM20 20l-4-4',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z',
  plus: 'M12 5v14M5 12h14',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  printer: 'M7 8V3h10v5M7 17H4V9h16v8h-3M7 14h10v7H7z',
  close: 'M6 6l12 12M18 6L6 18',
  menu: 'M4 7h16M4 12h16M4 17h16',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 017 0v3',
  out: 'M10 4H4v16h6M15 8l4 4-4 4M9 12h10',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5',
  reset: 'M4 4v5h5M4.6 15a8 8 0 101.9-8.3L4 9',
  filter: 'M4 5h16l-6 7v6l-4 2v-8z'
};
function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ico');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  s.append(p);
  return s;
}

/* ---------- API (answered in the browser by api.js instead of a server) ---------- */
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
let mutateTimer = null;
async function api(path, opts) {
  opts = opts || {};
  const o = { method: opts.method || 'GET' };
  let res;
  try { res = await HostelAPI.request(o.method, path, opts.body); }
  catch (e) { throw new ApiError('The in-browser database stopped working. Reload the page.', 0); }
  const data = res.data;
  if (!res.ok) {
    if (res.status === 401 && path !== '/login' && typeof onSignedOut === 'function') onSignedOut();
    throw new ApiError((data && data.error) || ('Request failed (' + res.status + ')'), res.status);
  }
  if (o.method !== 'GET' && path !== '/login' && path !== '/logout' && path !== '/password') {
    invalidateLookups();
    clearTimeout(mutateTimer);
    mutateTimer = setTimeout(() => { if (typeof refreshBadges === 'function') refreshBadges(); }, 150);
  }
  return data;
}
const lookupCache = {};
function invalidateLookups() { for (const k of Object.keys(lookupCache)) delete lookupCache[k]; }
async function lookup(name) {
  if (!lookupCache[name]) lookupCache[name] = api('/lookup/' + name).catch(e => { delete lookupCache[name]; throw e; });
  return lookupCache[name];
}

/* ---------- formatting ---------- */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const nfCompact = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 });
function money(n) { return n == null || n === '' ? '' : '₹' + nf.format(Number(n)); }
function moneyShort(n) {
  n = Number(n) || 0;
  const a = Math.abs(n), f = x => String(Math.round(x * 10) / 10);
  if (a >= 1e7) return '₹' + f(n / 1e7) + ' Cr';
  if (a >= 1e5) return '₹' + f(n / 1e5) + ' L';
  if (a >= 1e3) return '₹' + f(n / 1e3) + 'K';
  return '₹' + f(n);
}
function fmtNum(n) { return nf.format(Number(n) || 0); }
function fmtDate(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const y = +m[1];
  return (+m[3]) + ' ' + MONTHS[+m[2] - 1] + (y !== new Date().getFullYear() ? ' ' + y : '');
}
function fmtDateTime(s) {
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(s);
  return m ? fmtDate(m[1]) + ', ' + m[2] : fmtDate(s);
}
function dash() { return el('span', { class: 'muted', text: '–' }); }

const TONES = {
  Paid: 'ok', Resolved: 'ok', Approved: 'ok', Good: 'ok',
  Pending: 'warn', 'In Progress': 'warn', Medium: 'warn', Important: 'warn', 'Needs Repair': 'warn',
  Overdue: 'bad', Open: 'bad', Rejected: 'bad', High: 'bad', Urgent: 'bad', Damaged: 'bad',
  Inside: 'info'
};
function pill(v) {
  if (v == null || v === '') return dash();
  const t = TONES[v];
  return el('span', { class: 'pill' + (t ? ' pill--' + t : ''), text: v });
}

/* ---------- toasts ---------- */
function toast(msg, kind) {
  const t = el('div', { class: 'toast' + (kind === 'bad' ? ' toast--bad' : ''), text: msg });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3200);
}
function fail(e) { toast(e && e.message ? e.message : 'Something went wrong.', 'bad'); }

/* ---------- overlays: modal, drawer, confirm ---------- */
const overlays = [];
function focusables(root) {
  return [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(n => n.offsetParent !== null);
}
function pushOverlay(root, close) {
  const opener = document.activeElement;
  const o = { root, close, opener };
  overlays.push(o);
  return o;
}
function popOverlay(o) {
  const i = overlays.indexOf(o);
  if (i >= 0) overlays.splice(i, 1);
  if (o.opener && o.opener.isConnected && typeof o.opener.focus === 'function') o.opener.focus();
}
document.addEventListener('keydown', e => {
  const top = overlays[overlays.length - 1];
  if (!top) return;
  if (e.key === 'Escape') { e.preventDefault(); top.close(); }
  else if (e.key === 'Tab') {
    const f = focusables(top.root);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

function openModal(opts) {
  const body = el('div', { class: 'modal__body' }, opts.body);
  const foot = el('div', { class: 'modal__foot' });
  const modal = el('div', { class: 'modal' + (opts.wide ? ' modal--wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
    el('div', { class: 'modal__head' },
      el('h2', { class: 'modal__title', text: opts.title }),
      el('button', { class: 'iconbtn modal__x', type: 'button', 'aria-label': 'Close', onclick: () => api_close() }, icon('close'))),
    body, opts.buttons ? foot : null);
  const scrim = el('div', { class: 'scrim' }, modal);
  scrim.addEventListener('mousedown', e => { if (e.target === scrim) api_close(); });
  document.body.append(scrim);
  const ov = pushOverlay(scrim, () => api_close());
  let closed = false;
  function api_close(result) {
    if (closed) return;
    closed = true;
    scrim.remove();
    popOverlay(ov);
    if (opts.onClose) opts.onClose(result);
  }
  const handle = { close: api_close, body, foot, modal, buttons: {} };
  (opts.buttons || []).forEach(b => {
    const btn = el('button', { class: 'btn' + (b.kind ? ' btn--' + b.kind : ''), type: 'button', text: b.label });
    btn.addEventListener('click', () => b.onClick(handle, btn));
    handle.buttons[b.label] = btn;
    foot.append(btn);
  });
  setTimeout(() => {
    const first = body.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])') || foot.querySelector('.btn--primary') || modal.querySelector('button');
    if (first) first.focus();
  }, 30);
  return handle;
}

function confirmBox(o) {
  return new Promise(resolve => {
    let answered = false;
    const done = v => { if (!answered) { answered = true; resolve(v); } };
    openModal({
      title: o.title, onClose: () => done(false),
      body: el('p', { text: o.text, style: 'margin:0' }),
      buttons: [
        { label: 'Cancel', onClick: m => m.close() },
        { label: o.ok || 'Confirm', kind: o.danger ? 'danger' : 'primary', onClick: m => { done(true); m.close(); } }
      ]
    });
  });
}

function openDrawer(o) {
  const body = el('div', { class: 'drawer__body' });
  const head = el('div', { class: 'drawer__head' },
    el('div', { style: 'min-width:0;flex:1' }, el('h2', { class: 'drawer__title', text: o.title }), o.sub ? el('div', { class: 'drawer__sub', text: o.sub }) : null),
    el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('close')));
  const drawer = el('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title }, head, body);
  const scrim = el('div', { class: 'drawer-scrim' });
  scrim.addEventListener('mousedown', () => close());
  document.body.append(scrim, drawer);
  const ov = pushOverlay(drawer, () => close());
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    scrim.remove(); drawer.remove(); popOverlay(ov);
    if (H.drawer === handle) H.drawer = null;
  }
  const handle = { close, body, head, drawer };
  H.drawer = handle;
  setTimeout(() => drawer.querySelector('button').focus(), 30);
  return handle;
}

/* ---------- forms built from the server's field metadata ---------- */
async function buildForm(tm, values, mode) {
  values = values || {};
  const fields = tm.fields.filter(f => f.form);
  const refData = {};
  await Promise.all(fields.filter(f => f.ref).map(async f => { refData[f.ref] = await lookup(f.ref); }));

  const controls = {}, errEls = {};
  const grid = el('div', { class: 'formgrid' });
  for (const f of fields) {
    const id = 'f_' + tm.key + '_' + f.key;
    const val = values[f.key] == null ? '' : String(values[f.key]);
    const locked = mode === 'edit' && f.createOnly;
    let input;
    if (f.type === 'text') {
      input = el('textarea', { class: 'textarea', id, maxlength: f.maxLen || null });
      input.value = val;
    } else if (f.options || (f.ref && f.ref !== 'blocks')) {
      input = el('select', { class: 'select', id });
      if (!f.required || mode === 'create') input.append(el('option', { value: '', text: f.required ? 'Choose…' : 'Not set' }));
      const opts = f.options ? f.options.map(o => [o, o]) : refData[f.ref].map(r => [String(r.id), r.label]);
      opts.forEach(([v, l]) => input.append(el('option', { value: v, text: l })));
      input.value = val;
    } else {
      const type = f.type === 'int' || f.type === 'num' ? 'number' : f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : 'text';
      input = el('input', {
        class: 'input', id, type,
        step: f.type === 'num' ? '0.01' : f.type === 'int' ? '1' : null,
        min: f.min != null ? f.min : null, max: f.max != null ? f.max : null,
        maxlength: f.maxLen || null,
        list: f.ref === 'blocks' ? id + '_list' : null,
        autocomplete: 'off'
      });
      input.value = f.type === 'datetime' ? val.replace(' ', 'T') : val;
    }
    if (locked) input.disabled = true;
    if (f.required) input.setAttribute('aria-required', 'true');
    const err = el('div', { class: 'field__error', id: id + '_err', hidden: true });
    input.setAttribute('aria-describedby', id + '_err');
    controls[f.key] = input; errEls[f.key] = err;
    const full = f.type === 'text' || f.key === 'name' && false;
    grid.append(el('div', { class: 'field' + (full ? ' is-full' : '') },
      el('label', { class: 'field__label', for: id, text: f.label + (f.required ? ' *' : '') }),
      input,
      f.help ? el('div', { class: 'field__help', text: f.help }) : null,
      err,
      f.ref === 'blocks' ? el('datalist', { id: id + '_list' }, refData.blocks.map(b => el('option', { value: b.id }))) : null));
  }
  const banner = el('div', { class: 'banner', role: 'alert', hidden: true });
  const node = el('div', { style: 'display:grid;gap:14px' }, banner, grid);

  function showErr(key, msg) {
    const e = errEls[key], c = controls[key];
    e.textContent = msg || ''; e.hidden = !msg;
    if (msg) c.setAttribute('aria-invalid', 'true'); else c.removeAttribute('aria-invalid');
  }
  function validate() {
    let first = null;
    for (const f of fields) {
      const c = controls[f.key];
      if (c.disabled) continue;
      const v = c.value.trim();
      let msg = '';
      if (!v) { if (f.required) msg = f.label + ' is required.'; }
      else if (f.type === 'int' || f.type === 'num') {
        const n = Number(v);
        if (!Number.isFinite(n)) msg = f.label + ' must be a number.';
        else if (f.type === 'int' && !Number.isInteger(n)) msg = f.label + ' must be a whole number.';
        else if (f.min != null && n < f.min) msg = f.label + ' must be at least ' + f.min + '.';
        else if (f.max != null && n > f.max) msg = f.label + ' must be at most ' + f.max + '.';
      } else if (f.maxLen && v.length > f.maxLen) msg = f.label + ' can have at most ' + f.maxLen + ' characters.';
      showErr(f.key, msg);
      if (msg && !first) first = c;
    }
    if (first) first.focus();
    return !first;
  }
  return {
    node, validate,
    values() {
      const out = {};
      for (const f of fields) { const c = controls[f.key]; if (!c.disabled) out[f.key] = c.value.trim(); }
      return out;
    },
    error(msg) { banner.textContent = msg; banner.hidden = !msg; },
    clearError() { banner.hidden = true; }
  };
}

/* ---------- CSV download ---------- */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadCsv(name, header, rows) {
  const text = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  downloadBlob(name, new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
}
function downloadBlob(name, blob) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function stamp() { return new Date().toISOString().slice(0, 10); }
