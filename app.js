(() => {
  'use strict';

  const PAGE_SIZE = 10;
  const REFRESH_COOLDOWN_MS = 5000;
  const FIELD_INPUTS = { url: 'url', alias: 'alias', expiresAt: 'expires', password: 'link-password' };

  const numberFormat = new Intl.NumberFormat();
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

  const state = {
    links: [],
    stats: null,
    query: '',
    filter: 'all',
    sort: 'newest',
    limit: PAGE_SIZE,
    result: null,
    pendingDelete: null,
    lastRefresh: 0
  };

  const $ = (selector) => document.querySelector(selector);

  const loginView = $('#login-view');
  const appView = $('#app-view');
  const loginForm = $('#login-form');
  const loginError = $('#login-error');
  const loginUsername = $('#login-username');
  const loginPassword = $('#login-password');
  const loginSubmit = $('#login-submit');
  const createForm = $('#create-form');
  const createError = $('#create-error');
  const createSubmit = $('#create-submit');
  const urlInput = $('#url');
  const aliasInput = $('#alias');
  const expiresInput = $('#expires');
  const linkPasswordInput = $('#link-password');
  const optionsPanel = $('#options');
  const resultPanel = $('#result');
  const linksBody = $('#links-body');
  const linksEmpty = $('#links-empty');
  const linksCount = $('#links-count');
  const moreButton = $('#more-btn');
  const qrDialog = $('#qr-dialog');
  const confirmDialog = $('#confirm-dialog');
  const toastNode = $('#toast');

  let toastTimer = null;

  class ApiError extends Error {
    constructor(message, status, field) {
      super(message);
      this.status = status;
      this.field = field;
    }
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  async function api(path, { method = 'GET', body } = {}) {
    const options = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(path, options);
    } catch {
      throw new ApiError('Cannot reach the server. Check your connection and try again.', 0);
    }

    if (response.status === 204) {
      await response.text();
      return null;
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      if (response.status === 401 && !appView.hidden) {
        showLogin('Your session has expired. Please sign in again.');
      }
      throw new ApiError((data && data.error) || `Request failed (${response.status}).`, response.status, data && data.field);
    }
    return data;
  }

  function formatNumber(value) {
    return numberFormat.format(value);
  }

  function shortLabel(link) {
    return `${new URL(link.shortUrl).host}/${link.code}`;
  }

  function qrUrl(link, { format = 'png', size = 320, download = false } = {}) {
    const params = new URLSearchParams({ format, size: String(size) });
    if (download) params.set('download', '1');
    return `/api/links/${encodeURIComponent(link.code)}/qr?${params}`;
  }

  function timezoneOffset() {
    return -new Date().getTimezoneOffset();
  }

  function setMessage(node, message) {
    node.textContent = message || '';
    node.hidden = !message;
  }

  function toast(message, isError = false) {
    clearTimeout(toastTimer);
    toastNode.textContent = message;
    toastNode.classList.toggle('is-error', isError);
    toastNode.hidden = false;
    toastTimer = setTimeout(() => {
      toastNode.hidden = true;
    }, 2800);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = el('textarea', { class: 'clipboard-proxy', readonly: true, 'aria-hidden': 'true' });
      area.value = text;
      document.body.append(area);
      area.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      area.remove();
      return copied;
    }
  }

  async function copyLink(link) {
    const copied = await copyText(link.shortUrl);
    if (copied) toast('Link copied to clipboard');
    else toast('Could not copy automatically. Select the link and copy it manually.', true);
  }

  function closeDialogs() {
    for (const dialog of [qrDialog, confirmDialog]) {
      if (dialog.open) dialog.close();
    }
  }

  function showLogin(message) {
    state.links = [];
    state.stats = null;
    state.result = null;
    closeDialogs();
    resultPanel.hidden = true;
    appView.hidden = true;
    loginView.hidden = false;
    loginPassword.value = '';
    setMessage(loginError, message);
    (loginUsername.value ? loginPassword : loginUsername).focus();
  }

  async function showApp(username) {
    loginView.hidden = true;
    appView.hidden = false;
    $('#user-name').textContent = username || '';
    $('#alias-prefix').textContent = `${location.host}/`;
    await refresh();
  }

  async function refresh() {
    state.lastRefresh = Date.now();
    const [linkData, stats] = await Promise.all([
      api('/api/links'),
      api(`/api/stats?offset=${timezoneOffset()}`)
    ]);
    state.links = linkData.links;
    state.stats = stats;
    renderStats();
    renderAnalytics();
    renderLinks();
  }

  function refreshWithFeedback() {
    return refresh().catch((err) => toast(err.message, true));
  }

  function renderStats() {
    const { totals } = state.stats;
    $('#stat-links').textContent = formatNumber(totals.links);
    $('#stat-clicks').textContent = formatNumber(totals.clicks);
    $('#stat-active').textContent = formatNumber(totals.active);
    $('#stat-expired').textContent = totals.expired ? `${formatNumber(totals.expired)} expired` : '';
    $('#stat-protected').textContent = formatNumber(totals.protected);
  }

  function renderChart(daily) {
    const chart = $('#chart');
    chart.replaceChildren();
    const total = daily.reduce((sum, day) => sum + day.clicks, 0);
    const peak = Math.max(...daily.map((day) => day.clicks));

    chart.setAttribute('aria-label', `Clicks per day over the last ${daily.length} days: ${formatNumber(total)} in total`);
    $('#analytics-note').textContent = `${formatNumber(total)} ${total === 1 ? 'click' : 'clicks'} in the last ${daily.length} days`;
    $('#chart-empty').hidden = total > 0;

    for (const day of daily) {
      const label = dayFormat.format(new Date(`${day.date}T00:00:00Z`));
      const bar = el('div', { class: 'bar' });
      if (peak > 0 && day.clicks > 0) bar.style.height = `${Math.max((day.clicks / peak) * 100, 4)}%`;
      else bar.style.height = '0';

      chart.append(
        el(
          'div',
          { class: 'bar-col', title: `${label}: ${day.clicks} ${day.clicks === 1 ? 'click' : 'clicks'}` },
          el('div', { class: 'bar-track' }, el('span', { class: 'bar-value' }, day.clicks > 0 ? day.clicks : ''), bar),
          el('span', { class: 'bar-label' }, Number(day.date.slice(8)))
        )
      );
    }
  }

  function renderRank(list, items, emptyText, describe) {
    list.replaceChildren();
    if (!items.length) {
      list.append(el('li', { class: 'rank-empty' }, emptyText));
      return;
    }
    const peak = items[0].clicks;
    for (const item of items) {
      const { text, title } = describe(item);
      const bar = el('span', { class: 'rank-bar', 'aria-hidden': 'true' });
      bar.style.width = `${(item.clicks / peak) * 100}%`;
      list.append(
        el(
          'li',
          { class: 'rank-item' },
          bar,
          el('span', { class: 'rank-name', title }, text),
          el('span', { class: 'rank-count' }, formatNumber(item.clicks))
        )
      );
    }
  }

  function renderAnalytics() {
    const { daily, topLinks, referrers, devices } = state.stats;
    renderChart(daily);
    renderRank($('#rank-links'), topLinks, 'No clicks yet', (item) => ({ text: shortLabel(item), title: item.url }));
    renderRank($('#rank-referrers'), referrers, 'No clicks yet', (item) => ({ text: item.name, title: item.name }));
    renderRank($('#rank-devices'), devices, 'No clicks yet', (item) => ({ text: item.name, title: item.name }));
  }

  function visibleLinks() {
    const query = state.query.trim().toLowerCase();
    const matches = state.links.filter((link) => {
      if (state.filter === 'active' && link.expired) return false;
      if (state.filter === 'expired' && !link.expired) return false;
      if (state.filter === 'protected' && !link.protected) return false;
      if (!query) return true;
      return (
        link.code.toLowerCase().includes(query) ||
        link.url.toLowerCase().includes(query) ||
        link.shortUrl.toLowerCase().includes(query)
      );
    });

    if (state.sort === 'oldest') return matches.slice().reverse();
    if (state.sort === 'clicks') return matches.slice().sort((a, b) => b.clicks - a.clicks);
    return matches;
  }

  function renderRow(link) {
    const badges = [];
    if (link.protected) badges.push(el('span', { class: 'badge badge-lock' }, 'Protected'));
    if (link.expired) badges.push(el('span', { class: 'badge badge-expired' }, 'Expired'));

    const lastClick = link.lastClickedAt ? `Last click ${dateTimeFormat.format(new Date(link.lastClickedAt))}` : 'No clicks yet';
    const expires = link.expiresAt
      ? el('span', { title: dateTimeFormat.format(new Date(link.expiresAt)) }, dateTimeFormat.format(new Date(link.expiresAt)))
      : el('span', { class: 'muted' }, 'Never');

    return el(
      'tr',
      { role: 'row' },
      el(
        'td',
        { class: 'cell-link', role: 'cell', 'data-label': 'Link' },
        el('a', { class: 'short', href: link.shortUrl, target: '_blank', rel: 'noopener' }, shortLabel(link)),
        badges.length ? el('span', { class: 'badges' }, badges) : null,
        el('div', { class: 'orig', title: link.url }, link.url)
      ),
      el('td', { class: 'num', role: 'cell', 'data-label': 'Clicks', title: lastClick }, formatNumber(link.clicks)),
      el(
        'td',
        { role: 'cell', 'data-label': 'Created', title: dateTimeFormat.format(new Date(link.createdAt)) },
        dateFormat.format(new Date(link.createdAt))
      ),
      el('td', { role: 'cell', 'data-label': 'Expires' }, expires),
      el(
        'td',
        { class: 'cell-actions', role: 'cell' },
        el('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'aria-label': `Copy link ${link.code}`, onclick: () => copyLink(link) }, 'Copy'),
        el('button', { class: 'btn btn-secondary btn-sm', type: 'button', 'aria-label': `Show QR code for ${link.code}`, onclick: () => openQr(link) }, 'QR'),
        el('button', { class: 'btn btn-quiet-danger btn-sm', type: 'button', 'aria-label': `Delete link ${link.code}`, onclick: () => askDelete(link) }, 'Delete')
      )
    );
  }

  function renderLinks() {
    const matches = visibleLinks();
    const shown = matches.slice(0, state.limit);
    linksBody.replaceChildren(...shown.map(renderRow));

    const filtering = Boolean(state.query.trim()) || state.filter !== 'all';
    if (!state.links.length) {
      setMessage(linksEmpty, 'No links yet. Paste a URL above to create your first short link.');
    } else if (!matches.length) {
      setMessage(linksEmpty, filtering ? 'No links match your search or filter.' : '');
    } else {
      setMessage(linksEmpty, '');
    }

    if (!matches.length) linksCount.textContent = '';
    else if (filtering) linksCount.textContent = `Showing ${shown.length} of ${matches.length} matching (${state.links.length} total)`;
    else linksCount.textContent = `Showing ${shown.length} of ${state.links.length} ${state.links.length === 1 ? 'link' : 'links'}`;

    moreButton.hidden = matches.length <= shown.length;
  }

  function showResult(link) {
    state.result = link;
    const image = $('#result-qr');
    image.src = qrUrl(link, { size: 192 });
    image.alt = `QR code for ${link.shortUrl}`;

    const anchor = $('#result-link');
    anchor.href = link.shortUrl;
    anchor.textContent = link.shortUrl;

    const meta = [link.expiresAt ? `Expires ${dateTimeFormat.format(new Date(link.expiresAt))}` : 'Never expires'];
    if (link.protected) meta.push('Password protected');
    $('#result-meta').textContent = meta.join(' · ');
    resultPanel.hidden = false;
  }

  function openQr(link) {
    const image = $('#qr-image');
    image.src = qrUrl(link, { size: 640 });
    image.alt = `QR code for ${link.shortUrl}`;
    $('#qr-link').textContent = link.shortUrl;
    $('#qr-png').href = qrUrl(link, { format: 'png', size: 1024, download: true });
    $('#qr-svg').href = qrUrl(link, { format: 'svg', download: true });
    $('#qr-dialog').dataset.code = link.code;
    qrDialog.showModal();
  }

  function askDelete(link) {
    state.pendingDelete = link;
    const clicks = link.clicks === 1 ? '1 recorded click' : `${formatNumber(link.clicks)} recorded clicks`;
    $('#confirm-text').textContent = `${shortLabel(link)} will stop working and its ${clicks} will be removed. This cannot be undone.`;
    confirmDialog.showModal();
  }

  function normalizeUrl(value) {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  function showCreateError(err) {
    setMessage(createError, err.message);
    const inputId = FIELD_INPUTS[err.field];
    if (!inputId) return;
    if (inputId !== 'url') optionsPanel.open = true;
    $(`#${inputId}`).focus();
  }

  async function handleCreate(event) {
    event.preventDefault();
    setMessage(createError, '');

    const url = normalizeUrl(urlInput.value);
    if (!url) {
      showCreateError({ message: 'Enter the URL you want to shorten.', field: 'url' });
      return;
    }

    const payload = { url };
    const alias = aliasInput.value.trim();
    if (alias) payload.alias = alias;
    if (linkPasswordInput.value) payload.password = linkPasswordInput.value;
    if (expiresInput.value) {
      const expires = new Date(expiresInput.value);
      if (Number.isNaN(expires.getTime())) {
        optionsPanel.open = true;
        showCreateError({ message: 'Choose a valid expiration date and time.', field: 'expiresAt' });
        return;
      }
      payload.expiresAt = expires.toISOString();
    }

    createSubmit.disabled = true;
    try {
      const link = await api('/api/links', { method: 'POST', body: payload });
      createForm.reset();
      showResult(link);
      toast('Short link created');
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      showCreateError(err);
    } finally {
      createSubmit.disabled = false;
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setMessage(loginError, '');
    if (!loginUsername.value.trim() || !loginPassword.value) {
      setMessage(loginError, 'Enter your username and password.');
      return;
    }

    loginSubmit.disabled = true;
    try {
      const session = await api('/api/login', {
        method: 'POST',
        body: { username: loginUsername.value.trim(), password: loginPassword.value }
      });
      loginPassword.value = '';
      await showApp(session.username);
    } catch (err) {
      setMessage(loginError, err.message);
      loginPassword.select();
    } finally {
      loginSubmit.disabled = false;
    }
  }

  async function handleLogout() {
    try {
      await api('/api/logout', { method: 'POST', body: {} });
    } catch (err) {
      toast(err.message, true);
      return;
    }
    loginUsername.value = '';
    showLogin();
  }

  async function confirmDelete() {
    const link = state.pendingDelete;
    if (!link) return;
    const button = $('#confirm-delete');
    button.disabled = true;
    try {
      await api(`/api/links/${encodeURIComponent(link.code)}`, { method: 'DELETE' });
      confirmDialog.close();
      if (state.result && state.result.id === link.id) {
        state.result = null;
        resultPanel.hidden = true;
      }
      toast('Link deleted');
      await refresh();
    } catch (err) {
      confirmDialog.close();
      toast(err.message, true);
      if (err.status === 404) await refreshWithFeedback();
    } finally {
      button.disabled = false;
      state.pendingDelete = null;
    }
  }

  function bindEvents() {
    loginForm.addEventListener('submit', handleLogin);
    createForm.addEventListener('submit', handleCreate);
    $('#logout-btn').addEventListener('click', handleLogout);
    $('#refresh-btn').addEventListener('click', async () => {
      await refreshWithFeedback();
      toast('Dashboard refreshed');
    });

    $('#search').addEventListener('input', (event) => {
      state.query = event.target.value;
      state.limit = PAGE_SIZE;
      renderLinks();
    });
    $('#filter').addEventListener('change', (event) => {
      state.filter = event.target.value;
      state.limit = PAGE_SIZE;
      renderLinks();
    });
    $('#sort').addEventListener('change', (event) => {
      state.sort = event.target.value;
      state.limit = PAGE_SIZE;
      renderLinks();
    });
    moreButton.addEventListener('click', () => {
      state.limit += PAGE_SIZE;
      renderLinks();
    });

    $('#result-copy').addEventListener('click', () => state.result && copyLink(state.result));
    $('#result-qr-btn').addEventListener('click', () => state.result && openQr(state.result));

    $('#qr-close').addEventListener('click', () => qrDialog.close());
    $('#qr-copy').addEventListener('click', () => {
      const link = state.links.find((item) => item.code === qrDialog.dataset.code) || state.result;
      if (link) copyLink(link);
    });
    $('#confirm-cancel').addEventListener('click', () => confirmDialog.close());
    $('#confirm-delete').addEventListener('click', confirmDelete);

    for (const dialog of [qrDialog, confirmDialog]) {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || appView.hidden) return;
      if (Date.now() - state.lastRefresh < REFRESH_COOLDOWN_MS) return;
      refresh().catch(() => {});
    });
  }

  async function boot() {
    bindEvents();
    try {
      const session = await api('/api/session');
      if (session.authenticated) await showApp(session.username);
      else showLogin();
    } catch (err) {
      showLogin(err.message);
    }
  }

  boot();
})();
