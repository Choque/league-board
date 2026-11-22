// Pure rules (no DOM, no network), shared by the engine and the tests.
(function (FB) {
  'use strict';

  const SLEEPER_TO_ESPN = { WAS: 'WSH' };
  const espn = t => SLEEPER_TO_ESPN[t] || t;
  FB.espnAbbr = espn;
  FB.f2 = v => (Math.round((v || 0) * 100) / 100).toFixed(2);   // scores to the hundredth, like Sleeper
  // a team name written together gets a space at each capital: HarborCityHammers -> Harbor City Hammers
  // (names that already have spaces stay as typed, so McLovin Squad keeps its McLovin)
  FB.spaceName = s => /\s/.test(s = String(s || '')) ? s : s.replace(/(?<=[a-zäöüß])(?=[A-ZÄÖÜ])/g, ' ');

  function clockSecs(c) { const m = /^(\d+):(\d+)/.exec(c || ''); return m ? +m[1] * 60 + +m[2] : 0; }
  function fracLeft(state, period, clock) {
    if (state === 'pre') return 1;
    if (state === 'post') return 0;
    if ((period || 1) > 4) return 0.02;
    return Math.max(0.02, ((4 - (period || 1)) * 900 + clockSecs(clock)) / 3600);
  }
  // "DET 35" with DET on offense -> 65 yards to the end zone; "NE 35" -> 35
  function yardsToEnd(text, pos) {
    const m = /^(?:([A-Z]+)\s+)?(\d+)$/.exec((text || '').trim());
    if (!m) return null;
    const n = +m[2];
    return m[1] && m[1] === pos ? 100 - n : n;
  }

  // ESPN scoreboard -> { teamAbbr: game } (both teams point at the same game object)
  FB.games = function (sb) {
    const out = {};
    for (const e of (sb && sb.events) || []) {
      const c = e.competitions && e.competitions[0];
      if (!c) continue;
      const st = e.status || {}, state = (st.type && st.type.state) || 'pre', sit = c.situation || {};
      const byId = {};
      (c.competitors || []).forEach(t => { byId[t.team.id] = t.team.abbreviation; });
      const pos = sit.possession ? byId[sit.possession] || null : null;
      const yte = yardsToEnd(sit.possessionText, pos);
      const g = {
        id: e.id, name: e.shortName, state, period: st.period || 0, clock: st.displayClock || '', date: e.date || '',
        half: !!(st.type && st.type.name === 'STATUS_HALFTIME'),
        left: fracLeft(state, st.period, st.displayClock), pos, yte,
        // ESPN's flag alone isn't enough: it stays on through timeouts and kickoffs with no yard line
        rz: !!sit.isRedZone && yte != null && yte <= 20, dd: sit.downDistanceText || '',
        teams: (c.competitors || []).map(t => ({ abbr: t.team.abbreviation, score: +t.score || 0,
          color: '#' + (t.team.color || '3a4256'), alt: '#' + (t.team.alternateColor || 'ffffff'), home: t.homeAway === 'home' })),
      };
      g.teams.forEach(t => { out[t.abbr] = g; });
    }
    return out;
  };

  FB.gameOf = (p, gi) => gi[espn(p.team)] || null;
  // the small line under a player's name, like Sleeper's: "Q3 4:12 · vs PIT", "W 35–13 @ ATL", "Sun 19:00 · @ ATL" (your time zone)
  FB.gameLine = function (g, team) {
    const me = g && g.teams.find(t => t.abbr === espn(team)), them = g && g.teams.find(t => t !== me);
    if (!me || !them) return '';
    const vs = (me.home ? 'vs ' : '@ ') + them.abbr;
    if (g.state === 'post') return (me.score > them.score ? 'W ' : me.score < them.score ? 'L ' : 'T ') + me.score + '–' + them.score + ' ' + vs;
    if (g.state === 'in') return (g.half ? 'Half' : (g.period > 4 ? 'OT' : 'Q' + g.period) + ' ' + g.clock) + ' · ' + vs;
    const d = new Date(g.date);
    return isNaN(d) ? vs : d.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '') + ' · ' + vs;
  };
  FB.isLive = (p, gi) => { const g = FB.gameOf(p, gi); return !!g && g.state === 'in'; };

  // team defense and individual defenders (IDP leagues)
  const DEFENSE = { DEF: 1, DL: 1, DE: 1, DT: 1, LB: 1, DB: 1, CB: 1, S: 1, IDP: 1 };
  FB.isDefense = p => !!DEFENSE[p.pos];

  // Is he out there right now? Offense when his team has the ball, defense (D/ST, IDP) when the other team has it.
  FB.onField = function (p, gi) {
    const g = FB.gameOf(p, gi);
    if (!g || g.state !== 'in' || !g.pos) return false;
    const ours = g.pos === espn(p.team);
    if (FB.isDefense(p)) return !ours;
    // shortcut: no "kicking now" signal in the scoreboard, so a kicker shows inside the 40; upgrade with play-by-play
    if (p.pos === 'K') return ours && g.yte != null && g.yte <= 40;
    return ours;
  };
  FB.inRedZone = function (p, gi) {
    const g = FB.gameOf(p, gi);
    return !!g && g.state === 'in' && g.rz && g.pos === espn(p.team) && !FB.isDefense(p) && p.pos !== 'K';
  };

  // A projection in the league's own scoring: Sleeper's projected stat lines × the league's scoring_settings (same keys).
  // Checked against Sleeper's app for a custom-scoring IDP league: exact to the hundredth.
  // shortcut: threshold bonuses (bonus_rec_yd_100 …) can't be applied to projected averages and are left out
  FB.projPoints = function (stats, scoring) {
    if (!stats) return 0;
    if (!scoring) return stats.pts_ppr || 0;
    let t = 0;
    for (const k in scoring) if (stats[k]) t += stats[k] * scoring[k];
    return t;      // unrounded, like Sleeper: rounding first moves a live projection by a hundredth
  };

  // Sleeper's live projection, as its web app computes it: the pre-game projection slides toward the player's pace as the
  // clock runs. f = share of his game left (1 before kickoff, 0 when final). Matches Sleeper to the hundredth.
  // dst: a team defense, whose pace Sleeper damps (matchup screen and win % alike: its app showed 57 % where undamped gave 51)
  FB.liveProj = function (pts, proj, f, dst) {
    if (f <= 0 && pts < 0) return pts;
    const pace = (pts + pts / (60 - 60 * f || 1) * 60 * f * f) * (dst ? 0.25 + 0.05 * f : 1);   // Sleeper's pace term, its extra f included
    const h = f >= 1 ? proj : Math.max(proj, pts);
    return h + (1 - f) * (Math.max(pace, pts) - h);
  };

  // One side of a matchup: points so far, live projected total (as Sleeper shows it and counts it for win %),
  // how much game time is left in total (0 = all done)
  FB.side = function (starters, pts, proj, gi, players) {
    let live = 0, total = 0, left = 0;
    (starters || []).forEach((id, i) => {
      if (!id || id === '0') return;
      const v = (pts && pts[i]) || 0, p = players[id], g = p ? FB.gameOf(p, gi) : null, f = g ? g.left : 0, pr = (proj && proj[id]) || 0;
      live += v;
      total += FB.liveProj(v, pr, f, /^[a-z]+$/i.test(id));
      left += f;
    });
    return { live, total, left };
  };

  function phi(z) { // standard normal CDF (Abramowitz-Stegun 7.1.26)
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
    return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
  }
  // Sleeper's win probability, as its web app computes it: each side is a bell curve around its projected total,
  // wider the more of that total is still to come; win % = chance yours ends higher, held to 1–99 while games are left
  const spread = (now, proj) => { const n = 1 + 10 * (1 - now / proj), v = (now - proj) ** 2 / n; return n > 0 && v > 0 && isFinite(v) ? v : 0.1; };
  FB.winPct = function (my, their) {
    const done = x => x.live.toFixed(2) === x.total.toFixed(2);
    if (done(my) && done(their)) { const d = +my.live.toFixed(2) - +their.live.toFixed(2); return d > 0 ? 100 : d < 0 ? 0 : 50; }
    const p = phi((my.total - their.total) / Math.sqrt(spread(my.live, my.total) + spread(their.live, their.total)));
    return Math.round(100 * Math.min(0.99, Math.max(0.01, p)));
  };

  // Full-screen banners the settings can switch off. Off, a play shows as a small pop-up in the box instead (the points still
  // show); a final result has no small form, so it doesn't show. The old "Defense play pop-ups: Off" carries over as def off.
  FB.BANNERS = [['td', 'Touchdown'], ['big', 'Big play'], ['fg', 'Field goal'], ['def', 'Defense'], ['final', 'You won / lost']];
  FB.bannersOff = s => s.bannersOff || (s.defPops === false ? ['def'] : []);
  FB.forBanner = function (m, s) {
    const key = m.kind === 'won' || m.kind === 'lost' ? 'final' : m.kind;
    if (!FB.bannersOff(s).includes(key)) return m;
    return key === 'final' ? null : Object.assign({}, m, { kind: m.value < 0 ? 'bad' : 'play', word: undefined });
  };

  /* ---------- plays ---------- */
  const SUFFIX = /\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i;
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  FB.lastName = p => String(p.l || '').replace(SUFFIX, '').trim();
  const mentions = (p, text) => {
    const ln = FB.lastName(p);
    return !!ln && new RegExp('(^|[\\s.])' + reEsc(ln) + '\\b', 'i').test(text || '');
  };
  FB.yards = function (text) {
    const m = /for (-?\d+) yards?/i.exec(text || '') || /(\d+)[\s-]*(?:yd|yard)/i.exec(text || '');
    return m ? +m[1] : null;
  };
  // Which of his plays explains a points jump. ESPN lists plays oldest first.
  // shortcut: the newest play naming him (scoring play preferred for a big jump); Sleeper's lag can make this a later play
  FB.matchPlay = function (p, plays, delta) {
    const his = (plays || []).filter(x => mentions(p, x.text) && !/incomplete|no play/i.test(x.text));
    if (p.pos === 'K') {
      const k = his.filter(x => /field goal|extra point/i.test(x.type + ' ' + x.text));
      return k[k.length - 1] || null;
    }
    if (delta >= 4) { const s = his.filter(x => x.scoring); if (s.length) return s[s.length - 1]; }
    return his[his.length - 1] || null;
  };
  function role(p, text, type) {
    const t = (text || '').toLowerCase(), at = t.search(new RegExp(reEsc(FB.lastName(p).toLowerCase())));
    if (/pass from/.test(t)) return at >= 0 && at < t.indexOf('pass from') ? 'catch' : 'pass';
    if (/\bpass\b/.test(t)) return at >= 0 && at < t.indexOf(' pass') ? 'pass' : 'catch';
    if (/rush|\brun\b|scramble|end|guard|tackle|middle/.test(t + ' ' + (type || '').toLowerCase())) return 'run';
    return '';
  }

  // -> {kind: td|fg|big|play|bad, line: "66-yd TD catch"}
  FB.classify = function (delta, p, play) {
    if (!play) {     // no play found: guess from the size of the jump
      if (delta < 0) return { kind: 'bad', line: 'Points lost' };
      if (p.pos === 'K') return delta >= 3 ? { kind: 'fg', line: 'Field goal' } : { kind: 'play', line: 'Extra point' };
      if (FB.isDefense(p)) return { kind: 'play', line: 'Defense' };
      return delta >= 6 ? { kind: 'td', line: 'Touchdown' } : { kind: 'play', line: '+' + FB.f2(delta) };
    }
    const type = (play.type || '').toLowerCase(), text = play.text || '';
    const yds = play.yds != null ? play.yds : FB.yards(text), r = role(p, text, type);
    const y = yds != null ? Math.abs(yds) + '-yd ' : '';
    if (delta < 0 || /missed|no good/.test(type)) {
      const what = /intercept/i.test(type + text) ? 'Interception' : /fumble/i.test(type + text) ? 'Fumble'
        : /field goal/.test(type) ? y + 'FG missed' : /extra point/i.test(type + text) ? 'PAT missed' : (y + r).trim();
      return { kind: 'bad', line: what || 'Points lost' };
    }
    if (/touchdown/.test(type) || /touchdown/i.test(text)) return { kind: 'td', line: (y + 'TD ' + r).trim() };
    if (/field goal/.test(type) && !/missed|blocked/.test(type)) return { kind: 'fg', line: y + 'FG' };
    if (/extra point/i.test(type + text)) return { kind: 'play', line: 'Extra point' };
    if (yds != null && yds >= 20) return { kind: 'big', line: (y + r).trim() };
    return { kind: 'play', line: (y + r).trim() || '+' + FB.f2(delta) };
  };

  /* ---------- which rows a box shows ----------
     Three blocks, in this order: on the field, live but on the sideline, not playing now; inside each, Sleeper's lineup order.
     view 'field' = block 1, 'live' = blocks 1+2, 'all' = all three. With a row limit, live players stay pinned and only
     the rest page; when even the live ones don't fit, everyone pages in block order. A moment's player is always on screen. */
  FB.pageRows = function (rows, view, max, page, hotId) {
    const field = rows.filter(r => r.field);
    const live = view === 'field' ? [] : rows.filter(r => !r.field && r.live);
    const idle = view === 'all' ? rows.filter(r => !r.field && !r.live) : [];
    const block = {};
    field.forEach(r => { block[r.id] = 0; }); live.forEach(r => { block[r.id] = 1; }); idle.forEach(r => { block[r.id] = 2; });
    const N = max > 0 ? max : Infinity, pinned = field.concat(live);
    // pages split evenly (7 in 6 rows -> 4 + 3, not 6 + 1), so the box doesn't jump from tall to tiny
    const chunk = (list, size) => {
      const n = Math.ceil(list.length / size), even = Math.ceil(list.length / n), i = page % n;
      return { part: list.slice(i * even, i * even + even), n, i };
    };
    let shown, pages = 1, at = 0, c;
    if (pinned.length + idle.length <= N) shown = pinned.concat(idle);
    // the live players alone fill the box: nothing can stay pinned, so the whole list pages in block order
    // (in 'all' that brings the others round too, instead of them never showing)
    else if (pinned.length >= N) { c = chunk(pinned.concat(idle), N); shown = c.part; pages = c.n; at = c.i; }
    else { c = chunk(idle, N - pinned.length); shown = pinned.concat(c.part); pages = c.n; at = c.i; }
    if (hotId && !shown.some(r => r.id === hotId)) {
      const h = rows.find(r => r.id === hotId);
      if (h) {
        if (shown.length >= N) shown[shown.length - 1] = h; else shown.push(h);
        if (block[h.id] == null) block[h.id] = h.field ? 0 : h.live ? 1 : 2;
      }
    }
    return { shown, pages, at, block };
  };

  /* ---------- defensive plays ---------- */
  const DEF_TYPE = /sack|interception|fumble recovery \(opponent\)|safety|blocked|return touchdown|defensive touchdown/i;
  // The newest defensive play that explains a defender's jump: an IDP player is named in it (the sacker, the
  // interceptor, who forced or recovered the fumble); a D/ST is the team without the ball.
  FB.defPlay = function (p, plays) {
    const team = espn(p.team);
    const his = (plays || []).filter(x => DEF_TYPE.test(x.type) && (p.pos === 'DEF' ? !!x.off && x.off !== team : mentions(p, x.text)));
    return his[his.length - 1] || null;
  };
  // -> {word: big word on screen, line: the card's play line}
  FB.defClassify = function (p, play) {
    const t = (play.type || '').toLowerCase(), text = play.text || '', y = FB.yards(text);
    if (/touchdown/.test(t)) return /interception/.test(t) ? { word: 'Pick six', line: 'Interception return TD' } : { word: 'Defensive TD', line: 'Return touchdown' };
    if (/interception/.test(t)) return { word: 'Interception', line: 'Interception' };
    if (/sack/.test(t)) return { word: 'Sack', line: y != null ? Math.abs(y) + '-yd sack' : 'Sack' };
    if (/fumble/.test(t)) {
      const forced = p.pos !== 'DEF' && new RegExp('fumbles \\([^)]*' + reEsc(FB.lastName(p)), 'i').test(text);
      return { word: 'Fumble', line: forced ? 'Forced fumble' : 'Fumble recovery' };
    }
    if (/safety/.test(t)) return { word: 'Safety', line: 'Safety' };
    return { word: 'Blocked', line: 'Blocked kick' };
  };

  FB.leadBadge = function (myFrom, myTo, their) {
    if (their == null) return null;
    const was = myFrom - their, lead = myTo - their;
    if (myTo < myFrom) return { up: false, text: lead < 0 ? 'Down ' + FB.f2(-lead) : 'Lead cut to ' + FB.f2(lead) };
    if (was <= 0 && lead > 0) return { up: true, text: 'Takes the lead' };
    if (lead > 0) return { up: true, text: 'Up ' + FB.f2(lead) };
    if (lead === 0) return { up: true, text: 'Ties it' };
    return { up: true, text: 'Cuts it to ' + FB.f2(-lead) };
  };
  // Sleeper's injury_status -> the short tag Sleeper shows next to a name ('NA', 'DNR' and healthy get none)
  const INJ = { Questionable: 'QUES', Doubtful: 'D', Out: 'OUT', IR: 'IR', PUP: 'PUP', Sus: 'SUS' };   // QUES, OUT, IR as Sleeper writes them
  FB.injury = (status, part) => INJ[status] ? { short: INJ[status], long: status === 'Sus' ? 'Suspended' : status, part: part || '', q: status === 'Questionable' } : null;
  FB.projNote = (today, proj) => proj == null ? '' : today >= proj ? '+' + FB.f2(today - proj) + ' over' : FB.f2(proj - today) + ' to go';

  // The stream delay: everything waits here until its time + hold has passed.
  // when the play really happened (ESPN's wallclock), so a pop-up lands exactly "delay" seconds after it whatever the polling
  // rate; the poll time when there's no stamp or it looks wrong (in the future, or more than 5 minutes old)
  FB.playTime = (play, now) => { const t = play && play.at; return t && t <= now + 5000 && now - t < 300000 ? Math.min(t, now) : now; };

  FB.Hold = class {
    constructor() { this.items = []; }
    // in time order: a play stamped before the poll that found it goes ahead of that poll's view
    push(item, at) {
      const t = at == null ? Date.now() : at;
      let i = this.items.length;
      while (i > 0 && this.items[i - 1].at > t) i--;
      const e = { at: t, item };
      this.items.splice(i, 0, e);
      return e;
    }
    // a newer snapshot replaces the queued ones it would otherwise land in front of: they hold older numbers
    pushState(item, at) {
      const t = at == null ? Date.now() : at;
      this.items = this.items.filter(x => !(x.state && x.at > t));
      this.push(item, t).state = true;
    }
    take(holdS, now) {
      const cut = (now == null ? Date.now() : now) - holdS * 1000, out = [];
      while (this.items.length && this.items[0].at <= cut) out.push(this.items.shift().item);
      return out;
    }
  };
})(globalThis.FB = globalThis.FB || {});
