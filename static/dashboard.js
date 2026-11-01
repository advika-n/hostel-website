'use strict';
/* Hostel Desk - dashboard page. */

const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  kids.flat().forEach(k => k && n.append(k.nodeType ? k : document.createTextNode(String(k))));
  return n;
}
function panel(title, note, body, cls) {
  return el('section', { class: 'panel ' + (cls || '') },
    el('div', { class: 'panel__head' }, el('h2', { class: 'panel__title', text: title }), note ? el('span', { class: 'panel__note', text: note }) : null),
    el('div', { class: 'panel__body' }, body));
}
const SEG_COLORS = { Paid: 'var(--green)', Resolved: 'var(--green)', Pending: 'var(--brass)', 'In Progress': 'var(--brass)', Overdue: 'var(--red)', Open: 'var(--red)' };
function segBar(items, fmt) {
  const total = items.reduce((a, b) => a + Number(b.cnt), 0);
  if (!total) return el('p', { class: 'muted', text: 'Nothing to show yet.' });
  const bar = el('div', { class: 'seg', role: 'img', 'aria-label': items.map(i => i.label + ' ' + fmt(i.cnt)).join(', ') });
  const legend = el('div', { class: 'seg__legend' });
  items.forEach(i => {
    const c = SEG_COLORS[i.label] || 'var(--pine)';
    if (Number(i.cnt) > 0) bar.append(el('i', { style: 'width:' + (100 * i.cnt / total) + '%;background:' + c, title: i.label + ': ' + fmt(i.cnt) }));
    legend.append(el('span', {}, el('span', { class: 'swatch', style: 'background:' + c }), ' ' + i.label + ' ', el('b', { text: fmt(i.cnt) })));
  });
  return el('div', {}, bar, legend);
}
function monthBars(items) {
  const W = 520, Hh = 190, pad = { l: 8, r: 8, t: 22, b: 26 };
  const max = Math.max(1, ...items.map(i => Number(i.cnt)));
  const bw = (W - pad.l - pad.r) / items.length;
  const s = svg('svg', { class: 'svgchart', viewBox: `0 0 ${W} ${Hh}`, role: 'img', 'aria-label': 'Fees collected per month: ' + items.map(i => i.label + ' ' + money(i.cnt)).join(', ') });
  s.append(svg('line', { class: 'axis', x1: pad.l, x2: W - pad.r, y1: Hh - pad.b, y2: Hh - pad.b }));
  items.forEach((it, i) => {
    const h = Math.round((Hh - pad.t - pad.b) * Number(it.cnt) / max);
    const x = pad.l + i * bw + bw * 0.18, w = bw * 0.64, y = Hh - pad.b - h;
    const [yy, mm] = it.label.split('-');
    s.append(
      svg('rect', { class: 'bar' + (i === items.length - 1 ? ' bar--now' : ''), x, y: h ? y : Hh - pad.b - 1, width: w, height: h || 1, rx: 2 }, svg('title', {}, money(it.cnt))),
      svg('text', { class: 'val', x: x + w / 2, y: y - 6, 'text-anchor': 'middle' }, Number(it.cnt) ? moneyShort(it.cnt) : ''),
      svg('text', { x: x + w / 2, y: Hh - 8, 'text-anchor': 'middle' }, MONTHS[+mm - 1]));
  });
  return s;
}
function hbars(items) {
  const max = Math.max(1, ...items.map(i => Number(i.cnt)));
  return el('div', {}, items.map(i => el('div', { class: 'hbar' },
    el('span', { text: i.label }),
    el('span', { class: 'hbar__track' }, el('i', { class: 'hbar__fill', style: 'width:' + (100 * i.cnt / max) + '%' })),
    el('span', { class: 'hbar__val', text: fmtNum(i.cnt) }))));
}

function ledgerCell(href, num, label, note, tone) {
  return el('a', { class: 'ledger__cell', href },
    el('span', { class: 'ledger__num' + (tone ? ' ledger__num--' + tone : ''), text: num }),
    el('span', { class: 'ledger__label', text: label }),
    el('span', { class: 'ledger__note', text: note }));
}

function floorMap(rooms) {
  const byBlock = {};
  rooms.forEach(r => (byBlock[r.block] = byBlock[r.block] || []).push(r));
  const wrap = el('div', { class: 'floor' });
  const blocks = el('div', { class: 'floor__blocks' });
  let idx = 0;
  Object.keys(byBlock).sort().forEach(b => {
    const rs = byBlock[b];
    const cap = rs.reduce((a, r) => a + r.capacity, 0), occ = rs.reduce((a, r) => a + r.occupied, 0);
    const tiles = el('div', { class: 'tiles' });
    rs.forEach(r => {
      const dots = el('span', { class: 'dots', 'aria-hidden': 'true' });
      for (let i = 0; i < r.capacity; i++) dots.append(el('i', { class: 'dot' + (i < r.occupied ? ' dot--on' : '') }));
      const state = r.occupied >= r.capacity ? 'full' : r.occupied === 0 ? 'empty' : '';
      const t = el('button', {
        type: 'button', class: 'tile tile--in' + (state ? ' tile--' + state : ''), style: '--i:' + (idx++),
        'aria-label': 'Room ' + r.room_no + ', ' + r.occupied + ' of ' + r.capacity + ' beds taken',
        title: 'Room ' + r.room_no + ' - ' + money(r.rent) + ' rent'
      }, el('span', { class: 'tile__no', text: r.room_no }), dots);
      t.addEventListener('click', () => openRoom(r.room_no));
      tiles.append(t);
    });
    blocks.append(el('div', {},
      el('div', { class: 'block__head' }, el('span', { class: 'block__name', text: b }), el('span', { class: 'block__beds', text: occ + ' / ' + cap + ' beds' })),
      el('div', { class: 'block__meter' }, el('i', { style: 'width:' + (cap ? 100 * occ / cap : 0) + '%' })),
      tiles));
  });
  wrap.append(blocks, el('div', { class: 'legend' },
    el('span', { class: 'legend__item' }, el('span', { class: 'legend__swatch legend__swatch--full' }), 'Full'),
    el('span', { class: 'legend__item' }, el('span', { class: 'legend__swatch' }), 'Some beds free'),
    el('span', { class: 'legend__item' }, el('span', { class: 'legend__swatch legend__swatch--empty' }), 'Empty'),
    el('span', { class: 'muted', text: 'Click a room to see who stays there.' })));
  return wrap;
}

function listRows(rows, render, emptyText) {
  if (!rows.length) return el('p', { class: 'muted', text: emptyText });
  return el('div', { class: 'list' }, rows.map(render));
}

async function renderDashboard(root) {
  const [d, rooms] = await Promise.all([api('/dashboard'), api('/rooms?export=1&size=2000&sort=room_no&dir=asc')]);
  const k = d.kpis;
  const page = el('div', { class: 'page' });
  page.append(el('div', { class: 'page__head' }, el('div', {},
    el('h1', { class: 'page__title', text: 'Dashboard' }),
    el('p', { class: 'page__sub', text: k.students + ' students across ' + k.rooms + ' rooms. ' + (k.unallotted ? k.unallotted + ' still need a room.' : 'Everyone has a room.') }))));

  page.append(el('div', { class: 'panel ledger' },
    ledgerCell('#/rooms', k.occupancy + '%', 'Occupancy', k.occupied + ' of ' + k.capacity + ' beds'),
    ledgerCell('#/students?flag_unallotted=1', fmtNum(k.students), 'Students', k.unallotted + ' without a room', k.unallotted ? 'warn' : ''),
    ledgerCell('#/fees?f_status=Overdue', moneyShort(k.fees_overdue), 'Overdue fees', k.fees_overdue_count + ' bills', k.fees_overdue_count ? 'bad' : ''),
    ledgerCell('#/fees?f_status=Paid', moneyShort(k.fees_collected), 'Collected', money(k.fees_pending) + ' pending'),
    ledgerCell('#/complaints?f_status=Open', fmtNum(k.complaints_open), 'Open complaints', 'not yet resolved', k.complaints_open ? 'warn' : ''),
    ledgerCell('#/visitors?f_presence=Inside', fmtNum(k.visitors_inside), 'Visitors inside', 'right now'),
    ledgerCell('#/leaves?f_status=Pending', fmtNum(k.leaves_pending), 'Leave requests', 'waiting for a decision', k.leaves_pending ? 'warn' : '')));

  const grid = el('div', { class: 'grid' });
  grid.append(
    panel('Room map', k.vacant + ' beds free', floorMap(rooms.rows), 'span-8'),
    panel('Notice board', null, d.notices.length
      ? el('div', { class: 'board' }, d.notices.map(n => el('article', { class: 'note note--' + n.priority },
        el('h3', { class: 'note__title', text: n.title }),
        el('p', { class: 'note__body', text: n.body }),
        el('div', { class: 'note__meta' }, pill(n.priority), el('span', { text: fmtDate(n.posted_on) + ' by ' + n.posted_by })))))
      : el('p', { class: 'muted', text: 'No notices yet.' }), 'span-4'),
    panel('Fees collected', 'last 6 months', monthBars(d.collection_by_month), 'span-6'),
    panel('Fees by status', 'total amount', el('div', {}, segBar(d.fees_by_status, money),
      el('p', { class: 'muted', style: 'margin:12px 0 0', text: 'Overdue means the due date has passed and nothing has been paid.' })), 'span-6'),
    panel('Students by department', null, hbars(d.students_by_dept), 'span-4'),
    panel('Complaints', 'by status', el('div', {}, segBar(d.complaints_by_status, fmtNum)), 'span-4'),
    panel('Overdue fees', 'oldest first', listRows(d.overdue_fees, f => el('div', { class: 'list__row' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title', text: f.name }), el('div', { class: 'list__sub', text: f.fee_type + ', due ' + fmtDate(f.due_date) })),
      el('div', { class: 'list__end is-bad', text: money(f.amount) })), 'Nothing overdue.'), 'span-4'),
    panel('Open complaints', null, listRows(d.open_complaints, c => el('div', { class: 'list__row' },
      el('div', { class: 'list__main' }, el('div', { class: 'list__title', text: c.category + ' - ' + c.name }), el('div', { class: 'list__sub', text: c.description })),
      pill(c.priority), pill(c.status)), 'No open complaints.'), d.activity ? 'span-6' : 'span-12'));
  if (d.activity) grid.append(panel('Recent activity', 'admin only', listRows(d.activity, a => el('div', { class: 'list__row' },
    el('div', { class: 'list__main' }, el('div', { class: 'list__title', text: a.username + ' - ' + a.action + ' ' + (a.table_name || '').toLowerCase() }), el('div', { class: 'list__sub', text: a.detail || '' })),
    el('span', { class: 'muted', text: fmtDateTime(a.log_time) })), 'Nothing yet.'), 'span-6'));
  page.append(grid);
  clear(root).append(page);
}
