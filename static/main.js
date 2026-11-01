'use strict';
/* Hostel Desk - login, shell, router. */

const NAV = [
  { title: null, items: [['dashboard', 'Dashboard', 'dashboard']] },
  { title: 'Hostel', items: [['rooms', 'Rooms', 'rooms'], ['students', 'Students', 'students'], ['wardens', 'Wardens', 'wardens'], ['inventory', 'Room inventory', 'inventory']] },
  { title: 'Daily desk', items: [['fees', 'Fees', 'fees'], ['complaints', 'Complaints', 'complaints'], ['visitors', 'Visitors', 'visitors'], ['leaves', 'Leave requests', 'leaves'], ['notices', 'Notice board', 'notices']] },
  { title: 'Insight', items: [['reports', 'Reports', 'reports']] },
  { title: 'Admin', admin: true, items: [['audit', 'Audit log', 'audit'], ['users', 'Users', 'users']] }
];
const BADGES = { students: k => k.unallotted, fees: k => k.fees_overdue_count, complaints: k => k.complaints_open, visitors: k => k.visitors_inside, leaves: k => k.leaves_pending, inventory: k => k.items_attention };
const BADGE_TIPS = { students: 'without a room', fees: 'overdue', complaints: 'open', visitors: 'inside', leaves: 'waiting', inventory: 'need attention' };

function onSignedOut() {
  if (!H.user) return;
  H.user = null;
  showLogin('Your session ended. Please sign in again.');
}
async function refreshBadges() {
  if (!H.user) return;
  try {
    const d = await api('/dashboard');
    H.kpis = d.kpis;
    document.querySelectorAll('[data-badge]').forEach(n => {
      const key = n.dataset.badge, v = BADGES[key](H.kpis);
      n.textContent = v > 0 ? v : ''; n.hidden = !(v > 0);
      n.title = v + ' ' + BADGE_TIPS[key];
    });
  } catch (e) { /* badges are optional */ }
}

/* ---------- login ---------- */
function showLogin(message) {
  const root = clear($('#root'));
  const wall = el('div', { class: 'login__wall', 'aria-hidden': 'true' });
  const rooms = [101, 102, 103, 104, 105, 106, 201, 202, 203, 204, 205, 206, 301, 302, 303, 304, 305, 306, 401, 402, 403, 404, 405, 406];
  rooms.forEach((n, i) => wall.append(el('div', { class: 'login__door' + (i % 3 === 0 ? ' login__door--empty' : i % 4 === 1 ? '' : ' login__door--full'), text: n })));
  const user = el('input', { class: 'input', id: 'lu', autocomplete: 'username', required: true, autofocus: true });
  const pass = el('input', { class: 'input', id: 'lp', type: 'password', autocomplete: 'current-password', required: true });
  const err = el('div', { class: 'banner', role: 'alert', hidden: !message }, message || '');
  const go = el('button', { class: 'btn btn--primary', type: 'submit', text: 'Sign in' });
  const form = el('form', { class: 'login__card', novalidate: true },
    el('h1', { text: 'Sign in' }), el('p', { class: 'page__sub', style: 'margin:-8px 0 0', text: 'Use the account your hostel office gave you.' }),
    err,
    el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'lu', text: 'Username' }), user),
    el('div', { class: 'field' }, el('label', { class: 'field__label', for: 'lp', text: 'Password' }), pass),
    go, el('div', { class: 'login__hint', text: 'First time? Sign in as admin with password admin123, then change it from the account menu.' }),
    demoNotice(true));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!user.value.trim() || !pass.value) { err.textContent = 'Enter your username and password.'; err.hidden = false; return; }
    go.disabled = true; go.textContent = 'Signing in…';
    try {
      const me = await api('/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
      H.user = me;
      await startApp();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; go.disabled = false; go.textContent = 'Sign in'; pass.value = ''; pass.focus(); }
  });
  root.append(el('div', { class: 'login' },
    el('div', { class: 'login__art' }, wall,
      el('div', { class: 'login__brand' }, el('span', { class: 'brand__plate', text: 'H' }), el('span', { class: 'brand__name', text: 'Hostel Desk' })),
      el('div', {}, el('div', { class: 'login__tag', text: 'Every room, every bed, every bill in one place.' }), el('div', { class: 'login__tagsub', text: 'Allot rooms, collect fees, answer complaints and keep the notice board current.' }))),
    el('div', { class: 'login__form' }, form)));
  document.title = 'Sign in - Hostel Desk';
  setTimeout(() => user.focus(), 30);
}

/* ---------- demo build: the database lives in this browser ---------- */
function demoNotice(onLogin) {
  const memory = HostelAPI.storage() === 'memory';
  const n = el('div', { class: 'banner banner--info', role: 'note', style: 'font-weight:500;font-size:12.5px' },
    memory ? 'Demo version: this browser is blocking storage, so changes last only until you close the tab.'
      : 'Demo version: all data is stored only in this browser. Nothing is sent to a server.');
  if (onLogin) n.append(' ', el('button', { class: 'linkcell', type: 'button', text: 'Forgot the password? Reset to sample data.', onclick: resetData }));
  return n;
}
async function downloadDb() {
  try { downloadBlob('hostel-desk-' + stamp() + '.db', new Blob([await HostelAPI.exportDb()], { type: 'application/vnd.sqlite3' })); }
  catch (e) { fail(e); }
}
async function exportSql() {
  try { downloadBlob('hostel-desk-' + stamp() + '.sql', new Blob([await HostelAPI.exportSql()], { type: 'application/sql;charset=utf-8' })); }
  catch (e) { fail(e); }
}
async function resetData() {
  const ok = await confirmBox({ title: 'Reset to sample data?', text: 'Every change made in this browser is deleted and the sample hostel comes back. The only login will be admin / admin123.', ok: 'Reset', danger: true });
  if (!ok) return;
  try { await HostelAPI.reset(); } catch (e) { return fail(e); }
  location.hash = '';
  location.reload();
}

/* ---------- shell ---------- */
async function startApp() {
  const m = await api('/meta');
  H.meta = m.tables; H.user = m.user;
  const root = clear($('#root'));
  const nav = el('nav', { class: 'nav', 'aria-label': 'Main' });
  NAV.filter(g => !g.admin || isAdmin()).forEach(g => nav.append(el('div', { class: 'nav__group' },
    g.title ? el('div', { class: 'nav__title', text: g.title }) : null,
    g.items.map(([key, label, ic]) => el('a', { class: 'nav__link', href: '#/' + key, 'data-route': key }, icon(ic), label,
      BADGES[key] ? el('span', { class: 'nav__badge', 'data-badge': key, hidden: true }) : null)))));
  const rail = el('aside', { class: 'rail', id: 'rail' },
    el('a', { class: 'brand', href: '#/dashboard' }, el('span', { class: 'brand__plate', text: 'H' }), el('span', {}, el('div', { class: 'brand__name', text: 'Hostel Desk' }), el('div', { class: 'brand__sub', text: 'Room and fee management' }))), nav);
  const main = el('main', { class: 'main', id: 'main', tabindex: '-1' });
  const view = el('div', { id: 'view' });

  /* global search */
  const gs = el('input', { class: 'input gsearch__input', type: 'search', placeholder: 'Search students and rooms', 'aria-label': 'Search students and rooms', autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'gresults' });
  const gres = el('div', { class: 'results', id: 'gresults', role: 'listbox', hidden: true });
  let hits = [], sel = -1;
  const closeRes = () => { gres.hidden = true; gs.setAttribute('aria-expanded', 'false'); sel = -1; };
  const choose = h => {
    closeRes(); gs.value = '';
    if (h.kind === 'students') openStudent(h.id); else if (h.kind === 'rooms') openRoom(h.id);
    else location.hash = '#/' + h.kind + '?q=' + encodeURIComponent(h.label);
  };
  const paint = () => {
    clear(gres);
    if (!hits.length) gres.append(el('div', { class: 'results__none', text: 'No students or rooms match.' }));
    hits.forEach((h, i) => {
      const b = el('button', { class: 'results__item', type: 'button', role: 'option', 'aria-selected': String(i === sel) }, el('span', { class: 'results__kind', text: h.kind === 'students' ? 'Student' : 'Room' }), el('span', { text: h.label }), el('span', { class: 'results__sub', text: h.sub || '' }));
      b.addEventListener('mousedown', e => { e.preventDefault(); choose(h); });
      gres.append(b);
    });
    gres.hidden = false; gs.setAttribute('aria-expanded', 'true');
  };
  const doSearch = debounce(async () => {
    const q = gs.value.trim();
    if (q.length < 1) return closeRes();
    try { hits = (await api('/search?q=' + encodeURIComponent(q))).results; sel = -1; paint(); } catch (e) { closeRes(); }
  }, 200);
  gs.addEventListener('input', doSearch);
  gs.addEventListener('blur', () => setTimeout(closeRes, 120));
  gs.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && hits.length) { e.preventDefault(); sel = (sel + 1) % hits.length; paint(); }
    else if (e.key === 'ArrowUp' && hits.length) { e.preventDefault(); sel = (sel - 1 + hits.length) % hits.length; paint(); }
    else if (e.key === 'Enter' && hits[sel >= 0 ? sel : 0] && !gres.hidden) { e.preventDefault(); choose(hits[sel >= 0 ? sel : 0]); }
    else if (e.key === 'Escape') { closeRes(); gs.blur(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !document.querySelector('.scrim, .drawer')) { e.preventDefault(); gs.focus(); }
  });

  /* theme + account menu */
  const themeBtn = el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Switch between light and dark' });
  const paintTheme = () => { clear(themeBtn).append(icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon')); };
  themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('hd-theme', next); } catch (e) { /* private mode */ }
    paintTheme();
  });
  paintTheme();
  const menu = el('div', { class: 'menu', role: 'menu', hidden: true },
    el('button', { class: 'menu__item', type: 'button', role: 'menuitem', onclick: () => { menu.hidden = true; changePasswordDialog(); } }, icon('lock'), 'Change password'),
    el('button', { class: 'menu__item', type: 'button', role: 'menuitem', onclick: () => { menu.hidden = true; downloadDb(); } }, icon('database'), 'Download database (.db)'),
    el('button', { class: 'menu__item', type: 'button', role: 'menuitem', onclick: () => { menu.hidden = true; exportSql(); } }, icon('code'), 'Export SQL'),
    isAdmin() ? el('button', { class: 'menu__item', type: 'button', role: 'menuitem', onclick: () => { menu.hidden = true; resetData(); } }, icon('reset'), 'Reset to sample data') : null,
    el('button', { class: 'menu__item', type: 'button', role: 'menuitem', onclick: signOut }, icon('out'), 'Sign out'),
    el('div', { class: 'muted', style: 'padding:8px 10px 4px;font-size:12px;max-width:240px;border-top:1px solid var(--line);margin-top:4px' },
      HostelAPI.storage() === 'memory' ? 'Demo version: storage is blocked, so data lasts only until this tab closes.' : 'Demo version: data is stored only in this browser.'));
  const meBtn = el('button', { class: 'me__btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
    el('span', { class: 'me__avatar', text: H.user.username[0].toUpperCase() }), el('span', { text: H.user.username }), el('span', { class: 'me__role', text: H.user.role === 'ADMIN' ? 'Admin' : 'Viewer' }));
  meBtn.addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; meBtn.setAttribute('aria-expanded', String(!menu.hidden)); });
  document.addEventListener('click', () => { menu.hidden = true; meBtn.setAttribute('aria-expanded', 'false'); });
  async function signOut() { try { await api('/logout', { method: 'POST', body: {} }); } catch (e) { /* ignore */ } H.user = null; location.hash = ''; showLogin(); }

  const menuBtn = el('button', { class: 'iconbtn top__menu', type: 'button', 'aria-label': 'Open menu', onclick: () => rail.classList.toggle('is-open') }, icon('menu'));
  const top = el('header', { class: 'top' }, menuBtn,
    el('div', { class: 'gsearch' }, icon('search'), gs, el('span', { class: 'gsearch__key', 'aria-hidden': 'true', text: '/' }), gres),
    el('div', { class: 'top__spacer' }), themeBtn, el('div', { class: 'me' }, meBtn, menu));
  top.querySelector('.gsearch > .ico').classList.add('gsearch__ico');
  main.append(top, view);
  root.append(el('div', { class: 'app' }, rail, main));

  window.removeEventListener('hashchange', route);
  window.addEventListener('hashchange', route);
  if (!location.hash || location.hash === '#') location.hash = '#/dashboard'; else route();
  refreshBadges();
}

/* ---------- router ---------- */
let routeSeq = 0;
async function route() {
  if (!H.user) return;
  const view = $('#view');
  if (!view) return;
  const my = ++routeSeq;
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const params = new URLSearchParams(qs || '');
  const name = path || 'dashboard';
  document.querySelectorAll('.nav__link').forEach(a => { if (a.dataset.route === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('#rail').classList.remove('is-open');
  H.refreshPage = null;
  if (H.drawer) H.drawer.close();
  const title = (NAV.flatMap(g => g.items).find(i => i[0] === name) || [0, 'Hostel Desk'])[1];
  document.title = title + ' - Hostel Desk';
  try {
    if (name === 'dashboard') { H.refreshPage = () => renderDashboard(view); await renderDashboard(view); }
    else if (name === 'reports') await renderReports(view, params);
    else if (name === 'users') await renderUsers(view);
    else if (H.meta[name] && (name !== 'audit' || isAdmin())) await renderTable(view, name, params);
    else { clear(view).append(el('div', { class: 'page' }, el('div', { class: 'empty' }, el('p', { class: 'empty__title', text: 'Page not found' }), el('p', { class: 'empty__text', text: 'That page does not exist.' }), el('a', { class: 'btn btn--primary', href: '#/dashboard', text: 'Go to the dashboard' })))); }
  } catch (e) {
    if (my !== routeSeq || !H.user) return;
    clear(view).append(el('div', { class: 'page' }, el('div', { class: 'empty' }, el('p', { class: 'empty__title', text: 'Could not load this page' }), el('p', { class: 'empty__text', text: e.message }), el('button', { class: 'btn', type: 'button', text: 'Try again', onclick: route }))));
    return;
  }
  if (my === routeSeq) window.scrollTo(0, 0);
}

(async function boot() {
  try { H.user = await api('/me'); await startApp(); }
  catch (e) { H.user = null; showLogin(e.status === 401 ? null : e.message); }
})();
