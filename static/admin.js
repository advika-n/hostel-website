'use strict';
/* Hostel Desk - reports, users, change password. */

async function renderReports(root, params) {
  const list = (await api('/reports/list')).reports;
  let current = params.get('r') && list.find(r => r.key === params.get('r')) ? params.get('r') : list[0].key;
  const side = el('nav', { class: 'panel reportlist', 'aria-label': 'Reports' });
  const out = el('div');
  let data = null;
  list.forEach(r => {
    const b = el('button', { type: 'button', text: r.title, 'aria-current': String(r.key === current) });
    b.addEventListener('click', () => { current = r.key; side.querySelectorAll('button').forEach(x => x.setAttribute('aria-current', String(x === b))); history.replaceState(null, '', '#/reports?r=' + r.key); show(); });
    side.append(b);
  });
  const exp = el('button', { class: 'btn', type: 'button', onclick: () => data && downloadCsv(current + '-' + stamp() + '.csv', data.columns, data.rows) }, icon('download'), ' Export CSV');
  const prn = el('button', { class: 'btn', type: 'button', onclick: () => window.print() }, icon('printer'), ' Print');
  async function show() {
    out.classList.add('tbl--busy');
    try { data = await api('/reports/' + current); } catch (e) { out.classList.remove('tbl--busy'); return fail(e); }
    out.classList.remove('tbl--busy');
    const moneyCols = data.columns.map(c => /rent value|amount|total|paid|pending|overdue|collected|value|^avg rent$/i.test(c) && !/count|%|^(rooms|students)$/i.test(c));
    const pctCols = data.columns.map(c => /%/.test(c));
    const t = el('table', { class: 'tbl' }, el('caption', { class: 'sr-only', text: data.title }),
      el('thead', {}, el('tr', {}, data.columns.map((c, i) => el('th', { scope: 'col', class: isNumCol(i) ? 'is-num' : '', text: c })))),
      el('tbody', {}, data.rows.map(r => el('tr', {}, r.map((v, i) => el('td', { class: isNumCol(i) ? 'is-num' : '' },
        v == null ? dash() : moneyCols[i] && typeof v === 'number' ? money(v) : pctCols[i] && typeof v === 'number' ? v + '%' : typeof v === 'number' ? fmtNum(v) : /^\d{4}-\d{2}-\d{2}/.test(v) ? fmtDate(v) : String(v)))))));
    function isNumCol(i) { return data.rows.length && data.rows.every(r => r[i] == null || typeof r[i] === 'number'); }
    clear(out).append(
      el('div', { class: 'panel' }, el('div', { class: 'panel__head' }, el('h2', { class: 'panel__title', text: data.title }), el('span', { class: 'panel__note', text: data.rows.length + ' rows' })),
        el('div', { class: 'panel__body tablewrap' }, data.rows.length ? t : el('p', { class: 'muted', text: 'Nothing to report yet.' }))));
  }
  clear(root).append(el('div', { class: 'page' },
    el('div', { class: 'page__head' }, el('div', {}, el('h1', { class: 'page__title', text: 'Reports' }), el('p', { class: 'page__sub', text: 'Ready-made summaries. Export them or print them for the warden.' })), el('div', { class: 'page__tools' }, exp, prn)),
    el('div', { class: 'reports' }, side, out)));
  H.refreshPage = show;
  await show();
}

async function renderUsers(root) {
  if (!isAdmin()) { clear(root).append(el('div', { class: 'page' }, el('div', { class: 'empty' }, el('p', { class: 'empty__title', text: 'Admins only' }), el('p', { class: 'empty__text', text: 'Ask an admin if you need an account changed.' })))); return; }
  const wrap = el('div');
  async function load() {
    const d = await api('/users');
    const t = el('table', { class: 'tbl' }, el('caption', { class: 'sr-only', text: 'Users' }),
      el('thead', {}, el('tr', {}, ['User', 'Role', 'Created', 'Last sign-in'].map(h => el('th', { scope: 'col', text: h })), el('th', { class: 'is-act' }, el('span', { class: 'sr-only', text: 'Actions' })))),
      el('tbody', {}, d.rows.map(u => el('tr', {},
        el('td', {}, el('strong', { text: u.username }), u.username === H.user.username ? el('span', { class: 'muted', text: ' (you)' }) : null),
        el('td', {}, pill(u.role === 'ADMIN' ? 'Admin' : 'Viewer')),
        el('td', { text: fmtDate(u.created_on) }),
        el('td', {}, u.last_login ? fmtDateTime(u.last_login) : dash()),
        el('td', { class: 'is-act' },
          el('button', { class: 'btn btn--sm', type: 'button', text: u.role === 'ADMIN' ? 'Make viewer' : 'Make admin', onclick: async () => { try { await api('/users/' + encodeURIComponent(u.username), { method: 'PUT', body: { role: u.role === 'ADMIN' ? 'VIEWER' : 'ADMIN' } }); toast('Role updated.'); load(); } catch (e) { fail(e); } } }),
          el('button', { class: 'btn btn--sm', type: 'button', text: 'Reset password', onclick: () => resetPw(u.username) }),
          u.username === H.user.username ? null : el('button', { class: 'btn btn--sm btn--danger', type: 'button', text: 'Delete', onclick: async () => { if (await confirmBox({ title: 'Delete ' + u.username + '?', text: 'They will be signed out and cannot sign in again.', ok: 'Delete', danger: true })) { try { await api('/users/' + encodeURIComponent(u.username), { method: 'DELETE' }); toast('User deleted.'); load(); } catch (e) { fail(e); } } } }))))));
    clear(wrap).append(el('div', { class: 'tablewrap' }, t));
  }
  function resetPw(name) {
    const pw = el('input', { class: 'input', id: 'rp', type: 'password', autocomplete: 'new-password' });
    const err = el('div', { class: 'banner', role: 'alert', hidden: true });
    openModal({ title: 'Reset password for ' + name, body: [err, el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'rp', text: 'New password' }), pw, el('div', { class: 'field__help', text: 'At least 6 characters.' }))],
      buttons: [{ label: 'Cancel', onClick: m => m.close() }, { label: 'Reset password', kind: 'primary', onClick: async (m, b) => {
        b.disabled = true;
        try { await api('/users/' + encodeURIComponent(name), { method: 'PUT', body: { password: pw.value } }); m.close(); toast('Password changed.'); }
        catch (e) { err.textContent = e.message; err.hidden = false; b.disabled = false; }
      } }] });
  }
  function addUser() {
    const u = el('input', { class: 'input', id: 'nu', autocomplete: 'off' });
    const p = el('input', { class: 'input', id: 'np', type: 'password', autocomplete: 'new-password' });
    const r = el('select', { class: 'select', id: 'nr' }, el('option', { value: 'VIEWER', text: 'Viewer - can look, cannot change' }), el('option', { value: 'ADMIN', text: 'Admin - can change everything' }));
    const err = el('div', { class: 'banner', role: 'alert', hidden: true });
    openModal({ title: 'Add user', body: [err,
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'nu', text: 'Username' }), u, el('div', { class: 'field__help', text: '3-30 letters, digits, dot, dash or underscore.' })),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'np', text: 'Password' }), p, el('div', { class: 'field__help', text: 'At least 6 characters.' })),
      el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'nr', text: 'Role' }), r)],
      buttons: [{ label: 'Cancel', onClick: m => m.close() }, { label: 'Add user', kind: 'primary', onClick: async (m, b) => {
        b.disabled = true;
        try { await api('/users', { method: 'POST', body: { username: u.value.trim(), password: p.value, role: r.value } }); m.close(); toast('User added.'); load(); }
        catch (e) { err.textContent = e.message; err.hidden = false; b.disabled = false; }
      } }] });
  }
  clear(root).append(el('div', { class: 'page' },
    el('div', { class: 'page__head' }, el('div', {}, el('h1', { class: 'page__title', text: 'Users' }), el('p', { class: 'page__sub', text: 'People who can sign in. Viewers can look at everything but change nothing.' })),
      el('div', { class: 'page__tools' }, el('button', { class: 'btn btn--primary', type: 'button', onclick: addUser }, icon('plus'), ' Add user'))), wrap));
  H.refreshPage = load;
  await load();
}

function changePasswordDialog() {
  const mk = (id, label, ac) => [id, el('input', { class: 'input', id, type: 'password', autocomplete: ac }), label];
  const [, oldI] = mk('cp_old', 'Current password', 'current-password');
  const [, newI] = mk('cp_new', 'New password', 'new-password');
  const [, conI] = mk('cp_con', 'Repeat new password', 'new-password');
  const err = el('div', { class: 'banner', role: 'alert', hidden: true });
  const f = (i, l, h) => el('div', { class: 'field' }, el('label', { class: 'field__label', for: i.id, text: l }), i, h ? el('div', { class: 'field__help', text: h }) : null);
  openModal({ title: 'Change your password', body: [err, f(oldI, 'Current password'), f(newI, 'New password', 'At least 6 characters.'), f(conI, 'Repeat new password')],
    buttons: [{ label: 'Cancel', onClick: m => m.close() }, { label: 'Change password', kind: 'primary', onClick: async (m, b) => {
      if (newI.value !== conI.value) { err.textContent = 'The new passwords do not match.'; err.hidden = false; return; }
      b.disabled = true;
      try { await api('/password', { method: 'POST', body: { old_password: oldI.value, new_password: newI.value } }); m.close(); toast('Password changed.'); }
      catch (e) { err.textContent = e.message; err.hidden = false; b.disabled = false; }
    } }] });
}
