// Sales dashboard: views (All / Mine / Due today / Overdue), search, filters, lead rows.
import { t } from '../i18n.js';
import {
  state, can, $, $$, esc, bdi, api, icon, avatar, statusIcon, dueChip, leadChannel, channelName, fmtNum, relTime,
  loadingHtml, errorHtml, emptyHtml,
} from '../ui.js';
import { openNewLead } from './leadform.js';

export { openNewLead };

const STATUSES = ['new', 'attempted', 'interested', 'follow_up', 'won', 'lost'];
const VIEWS = [
  ['all', 'view.all', {}],
  ['mine', 'view.mine', { owner: 'me' }],
  ['today', 'view.today', { followup: 'today' }],
  ['overdue', 'view.overdue', { followup: 'overdue' }],
];
const blank = { q: '', status: '', owner: '', channel: '', followup: '', sort: 'updated' };
const listState = { view: 'all', ...blank };

const hasFilters = () => ['q', 'status', 'owner', 'channel', 'followup'].some((k) => listState[k]);

export async function leadsPage(ctx) {
  const counts = await api('GET', '/api/leads/counts');
  if (!ctx.alive()) return;
  const v = ctx.view;
  const viewAll = can('leads.view_all');
  const owners = state.users.filter((u) => u.can_own || u.id === state.me.id);

  v.innerHTML = `
    <header class="page-head">
      <h1>${esc(t('nav.leads'))}</h1>
      ${can('leads.create') ? `<button class="btn primary" data-act="new">${icon('plus')}${esc(t('leads.new'))}<kbd>C</kbd></button>` : ''}
    </header>
    <nav class="tabs" aria-label="${esc(t('nav.leads'))}">
      ${VIEWS.map(([k, label]) => `<button class="tab${listState.view === k ? ' on' : ''}${k === 'overdue' && counts.overdue ? ' alert' : ''}" data-view="${k}" aria-pressed="${listState.view === k}">
        ${esc(t(label))}<span class="count">${esc(fmtNum(counts[k]))}</span></button>`).join('')}
    </nav>
    <section class="filters" aria-label="${esc(t('filters'))}">
      <label class="search">${icon('search')}<input id="search" type="search" value="${esc(listState.q)}" placeholder="${esc(t('leads.search'))}" aria-label="${esc(t('leads.search'))}"><kbd>/</kbd></label>
      ${sel('status', t('field.status'), STATUSES.map((s) => [s, t(`status.${s}`)]))}
      ${viewAll ? sel('owner', t('field.owner'), [['me', t('filter.me')], ...owners.filter((u) => u.id !== state.me.id).map((u) => [String(u.id), u.name]), ['none', t('unassigned')]]) : ''}
      ${sel('channel', t('field.channel'), state.channels.map((c) => [String(c.id), channelName(c)]))}
      ${sel('followup', t('field.followup'), [['overdue', t('fu.overdue')], ['today', t('fu.today')], ['week', t('fu.week')], ['scheduled', t('fu.scheduled')], ['none', t('fu.none')]])}
      <label class="sel sort"><span class="sr">${esc(t('sort'))}</span>
        <select data-sort aria-label="${esc(t('sort'))}">
          ${['updated', 'followup', 'created', 'name', 'status'].map((k) => `<option value="${k}"${listState.sort === k ? ' selected' : ''}>${esc(t(`sort.${k}`))}</option>`).join('')}
        </select></label>
      <button class="link-btn" data-act="clear"${hasFilters() ? '' : ' hidden'}>${esc(t('filters.clear'))}</button>
    </section>
    <div id="list" class="list-wrap">${loadingHtml()}</div>`;

  v.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act], [data-view]');
    if (!el) return;
    if (el.dataset.view) return setView(ctx, el.dataset.view);
    const a = el.dataset.act;
    if (a === 'new') openNewLead();
    else if (a === 'clear') { Object.assign(listState, blank, { view: 'all' }); ctx.rerender(); }
    else if (a === 'more') loadList(ctx, Number(el.dataset.page));
    else if (a === 'retry') loadList(ctx);
  });
  v.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.filter) { listState[el.dataset.filter] = el.value; syncViewFromFilters(); refreshChrome(v); loadList(ctx); }
    else if (el.dataset.sort !== undefined) { listState.sort = el.value; loadList(ctx); }
  });
  let timer;
  v.querySelector('#search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { listState.q = e.target.value.trim(); refreshChrome(v); loadList(ctx); }, 220);
  });
  await loadList(ctx);
}

function sel(key, label, options) {
  return `<label class="sel${listState[key] ? ' set' : ''}"><span class="sr">${esc(label)}</span>
    <select data-filter="${key}" aria-label="${esc(label)}">
      <option value="">${esc(label)}</option>
      ${options.map(([val, l]) => `<option value="${esc(val)}"${String(listState[key]) === String(val) ? ' selected' : ''}>${esc(l)}</option>`).join('')}
    </select></label>`;
}

function setView(ctx, view) {
  const def = VIEWS.find(([k]) => k === view)?.[2] || {};
  Object.assign(listState, { view, owner: def.owner || '', followup: def.followup || '' });
  if (view === 'today' || view === 'overdue') listState.sort = 'followup';
  ctx.rerender();
}

/** Keep the view tab consistent when filters are changed by hand. */
function syncViewFromFilters() {
  const match = VIEWS.find(([, , d]) => (d.owner || '') === listState.owner && (d.followup || '') === listState.followup);
  listState.view = match ? match[0] : '';
}

function refreshChrome(v) {
  $$('.tab', v).forEach((b) => { const on = b.dataset.view === listState.view; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  $$('.sel[data-x], label.sel', v).forEach((l) => { const s = l.querySelector('select[data-filter]'); if (s) l.classList.toggle('set', !!s.value); });
  const clear = $('[data-act=clear]', v);
  if (clear) clear.hidden = !hasFilters();
}

async function loadList(ctx, page = 1) {
  const box = $('#list', ctx.view);
  const params = new URLSearchParams({ sort: listState.sort, page });
  for (const k of ['q', 'status', 'owner', 'channel', 'followup']) if (listState[k]) params.set(k, listState[k]);
  if (page === 1) box.classList.add('busy');
  let data;
  try {
    data = await api('GET', `/api/leads?${params}`);
  } catch (e) {
    if (!ctx.alive()) return;
    box.classList.remove('busy');
    box.innerHTML = errorHtml(e).replace('data-action="retry"', 'data-act="retry"');
    return;
  }
  if (!ctx.alive()) return;
  box.classList.remove('busy');

  if (!data.items.length && page === 1) {
    box.innerHTML = hasFilters()
      ? emptyHtml(t('leads.empty_filtered'), t('leads.empty_filtered_hint'), `<button class="btn" data-act="clear">${esc(t('filters.clear'))}</button>`, 'search')
      : emptyHtml(t('leads.empty'), t('leads.empty_hint'), can('leads.create') ? `<button class="btn primary" data-act="new">${icon('plus')}${esc(t('leads.new'))}</button>` : '');
    return;
  }

  const rows = data.items.map(rowHtml).join('');
  const more = page * data.limit < data.total
    ? `<button class="btn ghost block more" data-act="more" data-page="${page + 1}">${esc(t('load_more', { n: fmtNum(data.total - page * data.limit) }))}</button>` : '';
  if (page === 1) {
    box.innerHTML = `<div class="list-meta muted">${esc(t('leads.total', { n: fmtNum(data.total) }))}</div><ul class="rows" role="list">${rows}</ul>${more}`;
  } else {
    $('.more', box)?.remove();
    $('.rows', box).insertAdjacentHTML('beforeend', rows);
    box.insertAdjacentHTML('beforeend', more);
  }
}

function rowHtml(l) {
  const ch = leadChannel(l);
  return `<li><a class="row" href="#/leads/${l.id}">
    <span class="r-status" title="${esc(t(`status.${l.status}`))}">${statusIcon(l.status)}</span>
    <span class="r-main"><span class="r-name">${bdi(l.name)}</span>${l.company ? `<span class="r-company">${bdi(l.company)}</span>` : ''}</span>
    <span class="r-channel">${ch ? `<span class="chip">${bdi(ch)}</span>` : ''}</span>
    <span class="r-due">${l.followup ? dueChip(l.followup.due_at) : ''}</span>
    <span class="r-owner" title="${esc(l.owner_name || t('unassigned'))}">${avatar(l.owner_name, 'sm')}</span>
    <span class="r-updated muted">${esc(relTime(l.updated_at))}</span>
  </a></li>`;
}
