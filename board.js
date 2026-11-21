// The watch-party board: one Sleeper league on a second screen. Every matchup as a card, the players who matter now,
// a banner for any team's scoring play, all held back by the stream delay so the room never sees a play early.
// The league comes from the address: ?league=<id>, optionally &delay=<seconds>. Delay, matchups and position tags are in the settings panel.
(function () {
  'use strict';
  const FB = globalThis.FB;
  const BANNER_MS = 5000, BANNER_BUSY_MS = 4000, CHIP_MS = 6000, STAR_MS = 60000, ROW_MS = 7000, CARD_MS = 10000;
  const VERSION = '0.1.0';     // the board's own version, shown in the settings like the extension's
  const CARDS = 6, PLAYERS_TTL_MS = 24 * 3600 * 1000, KEY = 'fs-board';
  const WORD = { td: 'Touchdown', big: 'Big play', fg: 'Field goal' };
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f2 = FB.f2, signed = n => (n < 0 ? '−' : '+') + f2(Math.abs(n));
  const shortName = r => r.pos === 'DEF' ? (r.last || r.team) : (FB.lastName({ l: r.last }) || r.team);
  const TROPHY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v2h3v3a4 4 0 0 1-4 4h-.3A5 5 0 0 1 13 14.9V18h3v3H8v-3h3v-3.1A5 5 0 0 1 8.3 12H8a4 4 0 0 1-4-4V5h3V3zm-1 4v1a2 2 0 0 0 1 1.7V7H6zm11 0v2.7A2 2 0 0 0 18 8V7h-1z"/></svg>';
  const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';
  const ROWS = 5;      // rows per team
  const ini = s => String(s || '').split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();

  /* ---------- settings: the league from the address, the rest remembered in this browser ---------- */
  const q = new URLSearchParams(location.search);
  const DEMO = !!FB.BoardDemo;
  const leagueId = (q.get('league') || '').trim();
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } })();
  const s = { delay: typeof saved.delay === 'number' ? saved.delay : 30, off: saved.off || {}, pos: saved.pos !== false };
  if (q.get('delay') != null && q.get('delay') !== '' && !isNaN(+q.get('delay'))) s.delay = Math.max(0, Math.min(600, Math.round(+q.get('delay'))));
  // a delay changed in the settings goes into the address too, so a reload or a bookmark keeps it
  const delayToUrl = () => { try { q.set('delay', s.delay); history.replaceState(null, '', location.pathname + '?' + q.toString()); } catch (e) { /* file:// etc. */ } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* private mode: this session only */ } };
  const offHere = () => s.off[leagueId] || [];
  const posTags = () => document.getElementById('app').classList.toggle('no-pos', !s.pos);     // QB/RB/WR on the photos, or a cleaner look
  posTags();

  // Sleeper's player list is several MB: keep the slim copy for a day, like the extension does
  const fetchPlayers = FB.api.players;
  FB.api.players = async () => {
    try {
      const at = +localStorage.getItem('fs-board-playersAt') || 0, cached = localStorage.getItem('fs-board-players');
      if (cached && Date.now() - at < PLAYERS_TTL_MS) return JSON.parse(cached);
    } catch (e) { /* no storage: fetch */ }
    const p = await fetchPlayers();
    try { localStorage.setItem('fs-board-players', JSON.stringify(p)); localStorage.setItem('fs-board-playersAt', String(Date.now())); } catch (e) { /* too big */ }
    return p;
  };

  /* ---------- state ---------- */
  let hold = new FB.Hold(), view = null, err = null, fatal = null, queue = [], cur = null, curT = null;
  let rowPage = 0, cardPage = 0, wake = null;
  const deltas = {}, starred = {}, glow = {}, testFin = {};    // keys "roster:player" / matchup id -> { v, until } / until / { kind, until }

  const engine = new (FB.BoardDemo || FB.LeagueEngine)({
    view: v => (view ? hold.pushState({ view: v }, v.at) : setView(v)),     // the first view right away, the rest after the delay
    moment: m => hold.push({ moment: m }, m.at),
    status: msg => { if (msg !== err) { err = msg; drawBar(); } },
  });

  function league() { return view && view.leagues && view.leagues[0]; }
  function matchups() { const l = league(); return l ? l.matchups.filter(m => !offHere().includes(m.id)) : []; }

  function setView(v) {
    const now = Date.now(), was = {};
    const each = (vv, fn) => ((vv && vv.leagues[0] && vv.leagues[0].matchups) || []).forEach(m => [m.a, m.b].forEach(t => t.rows.forEach(r => fn(t.roster + ':' + r.id, r))));
    each(view, (k, r) => { was[k] = r.pts; });
    each(v, (k, r) => {
      const d = Math.round((r.pts - was[k]) * 100) / 100;
      if (Math.abs(d) >= 0.01) deltas[k] = { v: d, until: now + CHIP_MS };
    });
    view = v;
    render();
  }

  /* ---------- banners ---------- */
  function wordOf(m) {
    if (m.kind === 'def') return m.word || 'Defense';
    if (WORD[m.kind]) return WORD[m.kind];
    return m.value < 0 ? 'Points lost' : 'Play';
  }
  function next() {
    clearTimeout(curT);
    cur = queue.shift() || null;
    const el = $('.banner');
    if (!cur) { el.classList.remove('show'); return; }
    const now = Date.now(), k = cur.team.roster + ':' + cur.player.id;
    starred[k] = now + STAR_MS;
    glow[cur.matchup.id] = { kind: cur.kind, until: now + BANNER_MS };
    el.className = 'banner show k-' + cur.kind + (cur.value < 0 ? ' neg' : '');
    el.innerHTML = `<span class="w">${esc(wordOf(cur))}</span><span class="who">${esc(shortName(cur.player))}<small>${esc(cur.team.name)}</small></span>` +
      `<span class="v">${signed(cur.value)}</span><span class="ln">${esc(cur.line && !WORD[cur.kind] ? cur.line + ' · ' : '')}${esc(FB.matchupLine(cur)).replace(/(\d+\.\d\d–\d+\.\d\d)/, '<span class="nb">$1</span>')}</span>`;   // the score never breaks across lines
    render();
    curT = setTimeout(next, queue.length ? BANNER_BUSY_MS : BANNER_MS);
  }
  function banner(m) { queue.push(m); if (!cur) next(); }

  /* ---------- drawing ---------- */
  function drawBar() {
    const l = league();
    const live = l ? (l.liveGames ? `${l.liveGames} game${l.liveGames > 1 ? 's' : ''} live` : 'No games live') : '';
    $('.bar').innerHTML = `<span class="lg">${esc(l ? l.label : 'League Board')}</span>` +
      (l ? `<span class="wk">Week ${esc(l.week)}</span><span class="live${l.liveGames ? ' on' : ''}">${esc(live)}</span>` : '') +
      (err ? `<span class="err">No connection</span>` : '') + (s.delay ? `<span class="dly">−${s.delay}s</span>` : '');
  }
  function row(t, r, now) {
    const k = t.roster + ':' + r.id, d = deltas[k] && deltas[k].until > now ? deltas[k].v : null, star = starred[k] > now;
    const photo = r.photo ? `<img src="${esc(r.photo)}" alt="" data-ini="${esc(ini(r.first + ' ' + r.last))}">` : `<span class="ini">${esc(ini(r.first + ' ' + r.last))}</span>`;
    // a points change takes the tags' room while it shows (as in the overlay)
    const tags = (r.rz && d == null ? '<span class="tag rz">RZ</span>' : '') + (r.inj && d == null ? `<span class="tag inj${r.inj.q ? ' q' : ''}">${esc(r.inj.short)}</span>` : '');
    return `<div class="r${r.field ? ' on' : ''}${star ? ' star' : ''}"><span class="ph">${photo}<b class="pos p-${esc(r.pos)}">${esc(r.pos)}</b></span>` +
      `<span class="nm">${star && d == null ? STAR : ''}<span>${esc(shortName(r))}</span></span>${tags}` +     // the row's gold tint stays; the star makes room for the chip
      (d != null ? `<span class="dl num${d < 0 ? ' neg' : ''}">${signed(d)}</span>` : '') + `<span class="pt num">${f2(r.pts)}</span></div>`;
  }
  // res: 'won' / 'lost' / 'tie' once the matchup is over, else null
  function team(t, side, lead, now, res) {
    const starSet = new Set(Object.keys(starred).filter(k => starred[k] > now && k.startsWith(t.roster + ':')).map(k => k.slice(k.indexOf(':') + 1)));
    const over = res || (t.toPlay === 0 && t.done > 0 && !t.rows.some(r => r.live));     // everyone played: their best three instead of nobody
    const shown = over ? FB.topRows(t.rows, 3) : FB.boardRows(t.rows, ROWS, rowPage, starSet).shown;
    const logo = t.logo ? `<img class="logo" src="${esc(t.logo)}" alt="" data-ini="${esc(ini(t.name))}">` : `<span class="logo ini">${esc(ini(t.name))}</span>`;
    const tail = res ? `<span class="res ${res}">${res === 'won' ? TROPHY + 'Won' : res === 'lost' ? 'Lost' : 'Tie'}</span>` : `<span class="pj">PROJ ${f2(t.proj)}</span>`;
    return `<div class="side ${side}${lead ? ' lead' : ''}${res ? ' ' + res : ''}"><div class="th">${logo}<span class="tn">${esc(t.name)}</span>` +
      `<span class="scl"><span class="sc num">${f2(t.score)}</span>${tail}</span></div>` +
      `<div class="rows">${shown.map(r => row(t, r, now)).join('') || '<div class="none">Nobody playing now</div>'}</div>` +
      `<div class="left">${res ? `${t.done || t.rows.length} played` : `${t.toPlay} to play · ${t.done} done`}</div></div>`;
  }
  function card(m, now) {
    const g = glow[m.id] && glow[m.id].until > now ? glow[m.id].kind : null;
    const lead = m.a.score === m.b.score ? null : m.a.score > m.b.score ? 'a' : 'b';
    const fin = FB.isFinal(m) || testFin[m.id] > now, res = x => (!fin ? null : !lead ? 'tie' : lead === x ? 'won' : 'lost');
    if (fin) return `<section class="card fin${g ? ' glow k-' + g : ''}">` + team(m.a, 'a', lead === 'a', now, res('a')) +
      `<div class="win fin"><i></i><span>Final</span><i></i></div>` + team(m.b, 'b', lead === 'b', now, res('b')) + '</section>';
    return `<section class="card${g ? ' glow k-' + g : ''}">` + team(m.a, 'a', lead === 'a', now) +
      `<div class="win"><span class="${m.pctA > 50 ? 'lead' : ''}">${m.pctA}%</span><span class="wb">` +
      `<i class="${m.pctA > 50 ? 'lead' : ''}" style="width:${m.pctA}%"></i><i class="${m.pctA < 50 ? 'lead' : ''}" style="width:${100 - m.pctA}%"></i></span>` +
      `<span class="${m.pctA < 50 ? 'lead' : ''}">${100 - m.pctA}%</span></div>` +
      team(m.b, 'b', lead === 'b', now) + '</section>';
  }
  function empty(title, body) {
    $('.cards').className = 'cards empty';
    $('.cards').innerHTML = `<div class="msg"><h1>${esc(title)}</h1><p>${body}</p></div>`;
  }
  const HOWTO = 'Add <code>?league=</code> and your Sleeper league id to the address, for example ' +
    '<code>…/?league=1234567890&amp;delay=30</code>. The id is the number in your league\'s Sleeper link: ' +
    '<code>sleeper.com/leagues/<b>1234567890</b>/…</code>';
  function render() {
    drawBar();
    if (fatal) return empty('Couldn\'t load this league', esc(fatal) + '<br><br>' + HOWTO);
    if (!leagueId && !DEMO) return empty('No league provided', 'Nothing is loaded until the board knows which league to show.<br><br>' + HOWTO);
    if (!view) return empty('Loading the league…', '');
    const ms = matchups(), now = Date.now();
    if (!ms.length) return empty('No matchups this week', 'Sleeper has no matchups for this week, or every matchup is switched off in the settings.');
    const pages = Math.ceil(ms.length / CARDS), shown = ms.slice((cardPage % pages) * CARDS, (cardPage % pages) * CARDS + CARDS);
    const el = $('.cards');
    el.className = 'cards n' + shown.length;
    el.style.setProperty('--cols', shown.length);
    el.innerHTML = shown.map(m => card(m, now)).join('');
    fit(el);
  }
  // a long player name shrinks to its row, down to 60 %; only past that does the … show (like the overlay's boxes)
  function fit(root) {
    root.querySelectorAll('.r .nm > span').forEach(el => {
      el.style.fontSize = '';
      const box = el.closest('.nm') || el, base = parseFloat(getComputedStyle(el).fontSize);
      for (let k = 0.95; box.scrollWidth > box.clientWidth && k >= 0.6; k -= 0.05) el.style.fontSize = base * k + 'px';
    });
    // a wide score (153.38 on an iPad) gets narrower letters, not smaller ones, so every card's score keeps its height
    root.querySelectorAll('.th .sc').forEach(el => {
      el.style.fontStretch = '';
      const box = el.parentElement;
      for (let w = 105; box.scrollWidth > box.clientWidth && w >= 65; w -= 10) el.style.fontStretch = w + '%';
    });
  }
  // a broken headshot or logo becomes initials
  document.addEventListener('error', e => {
    const img = e.target;
    if (img.tagName !== 'IMG') return;
    const s2 = document.createElement('span');
    s2.className = (img.className ? img.className + ' ' : '') + 'ini';
    s2.textContent = img.dataset.ini || '';
    img.replaceWith(s2);
  }, true);

  /* ---------- settings panel ---------- */
  function link() { return location.origin + location.pathname + '?league=' + encodeURIComponent(leagueId) + '&delay=' + s.delay; }
  function testMoment(kind) {
    const ms = matchups();
    if (!ms.length) return;
    const m = ms[Math.floor(Math.random() * ms.length)], side = Math.random() < 0.5 ? 'a' : 'b', other = side === 'a' ? 'b' : 'a', t = m[side];
    const r = t.rows[Math.floor(Math.random() * t.rows.length)] || { id: 'x', first: 'Sample', last: 'Player', pos: 'WR', team: 'NYG', pts: 8 };
    const value = { td: 13.6, big: 4.0, play: 2.3, bad: -2.0 }[kind];
    const line = { td: '66-yd TD catch', big: '30-yd catch', play: '13-yd catch', bad: 'Fumble' }[kind];
    const score = Math.round((t.score + value) * 100) / 100;
    banner({ id: 'test:' + Date.now(), at: Date.now(), kind, line, value, player: r, team: { roster: t.roster, name: t.name },
      matchup: { id: m.id, a: { roster: m.a.roster, name: m.a.name, score: side === 'a' ? score : m.a.score },
        b: { roster: m.b.roster, name: m.b.name, score: side === 'b' ? score : m.b.score }, before: { [side]: t.score, [other]: m[other].score } } });
  }
  function testFinal() {      // one matchup looks finished for 20 s
    const ms = matchups();
    if (!ms.length) return;
    testFin[ms[Math.floor(Math.random() * ms.length)].id] = Date.now() + 20000;
    render();
  }
  function drawSetup() {
    const p = $('.setup'), l = league();
    if (p.hidden) return;
    const list = l ? l.matchups.map(m => {
      const on = !offHere().includes(m.id);
      return `<label class="mu"><input type="checkbox" data-mu="${m.id}"${on ? ' checked' : ''}> ${esc(m.a.name)} <span>vs</span> ${esc(m.b.name)}</label>`;
    }).join('') : '<p class="note">The matchups show up here once the league has loaded.</p>';
    p.innerHTML = `<div class="panel" role="dialog" aria-label="Board settings"><h2>Board settings <button data-act="close" aria-label="Close">✕</button></h2>` +
      `<section><h3>Delay</h3><div class="line">${[-10, -5, -1].map(n => `<button data-step="${n}">−${-n}</button>`).join('')}` +
      `<span class="hold">${s.delay} s</span>${[1, 5, 10].map(n => `<button data-step="${n}">+${n}</button>`).join('')}</div>` +
      `<p class="note">Banners show up before the play on the TV? Add seconds. After it? Take some away.</p></section>` +
      `<section><h3>Matchups</h3>${list}</section>` +
      `<section><h3>Position tags</h3><div class="line">${[[true, 'Show'], [false, 'Hide']].map(([v, t]) =>
        `<button data-pos="${v}" aria-pressed="${s.pos === v}"${s.pos === v ? ' class="on"' : ''}>${t}</button>`).join('')}</div>` +
      `<p class="note">QB, RB, WR on the player photos.</p></section>` +
      `<section><h3>Show a test</h3><div class="line">${[['td', 'Touchdown'], ['big', 'Big play'], ['play', 'Small play'], ['bad', 'Lost points'], ['fin', 'Final']]
        .map(([k, t]) => `<button data-test="${k}">${t}</button>`).join('')}</div></section>` +
      `<section><h3>Screen</h3><div class="line"><button data-act="full">Full screen</button></div>` +
      (leagueId ? `<p class="note">Same board on another device (click to copy):</p><button class="link" data-act="copy" title="Copy the link">${esc(link())}</button>` : '') + `</section>` +
      `<div class="credit">Made by <a href="https://github.com/Choque" target="_blank" rel="noopener noreferrer">Christopher Berg</a> · v${VERSION}</div></div>`;
  }
  // the clipboard API needs https or localhost; the textarea trick covers the rest
  async function copy(b) {
    const text = link();
    try { await navigator.clipboard.writeText(text); } catch (e) {
      const t = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch (e2) { /* nothing left to try */ }
      t.remove();
    }
    b.classList.add('done'); b.textContent = 'Copied ✓';
    setTimeout(drawSetup, 1500);
  }
  function openSetup(on) { $('.setup').hidden = !on; drawSetup(); }
  $('.setup').addEventListener('click', e => {
    if (e.target === e.currentTarget) return openSetup(false);
    const b = e.target.closest('button, input');
    if (!b) return;
    const d = b.dataset;
    if (d.act === 'close') return openSetup(false);
    if (d.act === 'copy') return copy(b);
    if (d.act === 'full') {
      const el = document.documentElement, go = el.requestFullscreen || el.webkitRequestFullscreen;
      if (go) go.call(el);
      return;
    }
    if (d.test) { openSetup(false); return d.test === 'fin' ? testFinal() : testMoment(d.test); }
    if (d.pos) { s.pos = d.pos === 'true'; save(); posTags(); drawSetup(); }
    if (d.step) { s.delay = Math.max(0, Math.min(600, s.delay + +d.step)); save(); delayToUrl(); drawSetup(); drawBar(); }
    if (d.mu) {
      const id = +d.mu, off = offHere().filter(x => x !== id);
      if (!b.checked) off.push(id);
      s.off[leagueId] = off; save(); render();
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') openSetup(false); });
  $('.gear').addEventListener('click', () => openSetup($('.setup').hidden));
  // the settings button shows for 3 s after the mouse moves or the screen is touched
  let gearT = null;
  const poke = () => { $('.gear').classList.add('show'); clearTimeout(gearT); gearT = setTimeout(() => $('.gear').classList.remove('show'), 3000); };
  ['mousemove', 'touchstart'].forEach(t => document.addEventListener(t, poke, { passive: true }));

  /* ---------- the loop ---------- */
  async function keepAwake() {
    const l = league(), want = !!(l && l.liveGames) && !document.hidden;
    try {
      if (want && !wake && navigator.wakeLock) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); }
      if (!want && wake) { await wake.release(); wake = null; }
    } catch (e) { /* not allowed here: the screen may sleep */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (engine.pause) engine.pause(); } else if (engine.resume) engine.resume();
    keepAwake();
  });
  setInterval(() => {
    for (const it of hold.take(s.delay)) { if (it.view) setView(it.view); else banner(it.moment); }
  }, 250);
  let lastRow = Date.now(), lastCard = Date.now();
  setInterval(() => {      // rows turn every 7 s, card pages every 10 s, only while games are live
    const l = league(), now = Date.now();
    if (!l || !l.liveGames) return render();
    if (now - lastRow >= ROW_MS) { rowPage++; lastRow = now; }
    if (now - lastCard >= CARD_MS) { cardPage++; lastCard = now; }
    render();
    keepAwake();
  }, 1000);

  render();
  if (leagueId || DEMO) engine.configure({ leagueId }).catch(e => {
    const msg = e.message || String(e);
    fatal = /HTTP 404|not found/i.test(msg) ? `There's no Sleeper league with the id ${leagueId}.` : msg;
    render();
  });
})();
