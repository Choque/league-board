// The engine: polls Sleeper + ESPN, builds the view (your teams, opponents, win %), and turns points jumps into moments.
// Everything it emits is "live"; content.js holds it back by the stream delay before the UI sees it.
(function (FB) {
  'use strict';
  const POLL_LIVE_MS = 5000, POLL_IDLE_MS = 60000, SLOW_MS = 600000;

  FB.findLeagues = async function (username) {
    const u = await FB.api.user(username);
    if (!u) throw new Error('No Sleeper user "' + username + '"');
    const st = await FB.api.state();
    const ls = await FB.api.leagues(u.user_id, st.league_season || st.season);
    return { user: u, leagues: (ls || []).map(l => ({ id: l.league_id, name: l.name })) };
  };

  // every roster's team name and logo (the team's own logo, else the owner's Sleeper avatar)
  FB.teamNames = function (rosters, users) {
    const names = {}, logos = {};
    rosters.forEach(r => {
      const u = users.find(x => x.user_id === r.owner_id) || {};
      names[r.roster_id] = FB.spaceName((u.metadata && u.metadata.team_name) || u.display_name || 'Team ' + r.roster_id);
      logos[r.roster_id] = (u.metadata && u.metadata.avatar) || (u.avatar ? 'https://sleepercdn.com/avatars/thumbs/' + u.avatar : '');
    });
    return { names, logos };
  };

  FB.Engine = class {
    constructor(out) { this.out = out; this.prev = null; this.won = {}; }

    async configure(s) {
      this.stop();
      this.meta = null; this.prev = null;
      if (!s.userId || !(s.leagueIds || []).length) return;
      this.meta = await Promise.all(s.leagueIds.map(async id => {
        const [league, rosters, users] = await Promise.all([FB.api.league(id), FB.api.rosters(id), FB.api.users(id)]);
        const mine = rosters.find(r => r.owner_id === s.userId || (r.co_owners || []).includes(s.userId));
        const { names, logos } = FB.teamNames(rosters, users);
        return { id, name: league.name, scoring: league.scoring_settings || null, roster: mine ? mine.roster_id : null,
          names, logos, record: mine ? mine.settings : null };
      }));
      this.meta = this.meta.filter(m => m.roster != null);
      this.start();
    }

    start() {
      this.stop();
      if (this.paused) return;
      const gen = this.gen = (this.gen || 0) + 1;     // a newer start() retires this loop
      const loop = async () => {
        let live = false;
        // a poll still running (paused and resumed mid-poll) is joined, not doubled
        try { live = await (this.ticking = this.ticking || this.tick().finally(() => { this.ticking = null; })); this.out.status(null); }
        catch (e) { this.out.status(e.message || String(e)); }
        if (gen === this.gen && !this.paused) this.timer = setTimeout(loop, live ? POLL_LIVE_MS : POLL_IDLE_MS);
      };
      loop();
    }
    stop() { clearTimeout(this.timer); this.gen = (this.gen || 0) + 1; }
    // no polling while the overlay is off, the tab is hidden or there's no video
    pause() { this.paused = true; this.stop(); }
    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.prev = null;           // what changed while away is old news: no pop-ups for it
      if (this.meta && this.meta.length) this.start();
    }

    async tick() {
      if (!this.meta || !this.meta.length) return false;
      const now = Date.now();
      if (!this.nfl || now - this.nflAt > SLOW_MS) { this.nfl = await FB.api.state(); this.nflAt = now; }
      const season = this.nfl.season, week = this.nfl.week;
      if (!this.players) this.players = await FB.api.players();
      if (!this.proj || now - this.projAt > SLOW_MS) {
        this.proj = {};
        this.inj = {};
        (await FB.api.projections(season, week) || []).forEach(r => {
          this.proj[r.player_id] = r.stats || {};
          if (r.player && r.player.injury_status) this.inj[r.player_id] = FB.injury(r.player.injury_status, r.player.injury_body_part);   // live: Sleeper sets it mid-game
        });
        this.projAt = now;
      }
      if (week !== this.statsWeek) { this.stats = {}; this.statsWeek = week; }
      // while games are on, also Sleeper's live stat lines (no games last poll: skip it; a failed fetch: league points only)
      const [sb, st, ...mus] = await Promise.all([FB.api.scoreboard(), this.anyLive === false ? null : FB.api.stats(season, week).catch(() => null),
        ...this.meta.map(m => FB.api.matchups(m.id, week))]);
      (st || []).forEach(r => { this.stats[r.player_id] = r.stats || {}; });
      const gi = FB.games(sb);
      this.anyLive = Object.values(gi).some(g => g.state === 'in');
      const leagues = this.meta.map((m, i) => this.league(m, mus[i] || [], gi, week)).filter(Boolean);
      const moments = this.prev ? await this.diff(leagues, gi, now) : [];
      this.prev = leagues;
      // stamped like this poll's newest play, so with a stream delay the new score lands together with its pop-up
      this.out.view({ at: moments.length ? Math.max(...moments.map(m => m.at)) : now, week, leagues, colors: colors(gi) });
      moments.forEach(m => this.out.moment(m));
      return this.anyLive;
    }

    // one roster's side of a matchup: live points, rows, total (league points plus what the stats feed is ahead by), FB.side
    sideOf(m, x, gi) {
      const projOf = id => FB.projPoints(this.proj[id], m.scoring);     // in this league's own scoring
      const projMap = () => { const o = {}; (x.starters || []).forEach(id => { o[id] = projOf(id); }); return o; };
      // a starter whose game is on or over today scores from the stats feed (Sleeper's league points trail it by about a minute)
      const pts = (x.starters || []).map((id, i) => {
        const p = this.players[id], g = p && FB.gameOf(p, gi);
        return this.stats[id] && g && g.state !== 'pre' ? FB.projPoints(this.stats[id], m.scoring) : (x.starters_points || [])[i] || 0;
      });
      const ahead = pts.reduce((t, v, i) => t + v - ((x.starters_points || [])[i] || 0), 0);
      const rows = (x.starters || []).map((id, i) => {
        if (!id || id === '0') return null;
        const p = this.players[id] || { f: '', l: id, pos: 'DEF', team: id };
        return { id, first: p.f, last: p.l, pos: p.pos, team: p.team, pts: pts[i],
          proj: this.proj[id] ? projOf(id) : null, live: FB.isLive(p, gi), field: FB.onField(p, gi), rz: FB.inRedZone(p, gi),
          photo: FB.photo(id, p.pos), inj: this.inj[id] || null, game: FB.gameLine(FB.gameOf(p, gi), p.team) };
      }).filter(Boolean);
      const total = Math.round(((x.custom_points != null ? x.custom_points : x.points || 0) + ahead) * 100) / 100;
      return { pts, rows, total, side: FB.side(x.starters, pts, projMap(), gi, this.players) };
    }

    league(m, mu, gi, week) {
      const me = mu.find(x => x.roster_id === m.roster);
      if (!me) return null;
      const opp = me.matchup_id != null ? mu.find(x => x.matchup_id === me.matchup_id && x.roster_id !== me.roster_id) : null;
      const a = this.sideOf(m, me, gi), b = opp ? this.sideOf(m, opp, gi) : null;
      return { id: m.id, label: m.name, week, me: m.names[me.roster_id], opp: opp ? m.names[opp.roster_id] : null,
        meLogo: m.logos[me.roster_id] || '', oppLogo: opp ? m.logos[opp.roster_id] || '' : '',
        my: a.total, their: b ? b.total : null, myProj: a.side.total, theirProj: b ? b.side.total : null,
        pct: b ? FB.winPct(a.side, b.side) : null, final: a.side.left === 0 && (!b || b.side.left === 0), record: m.record,
        mine: a.rows, theirs: b ? b.rows : [] };
    }

    // compare with the last poll: every starter of yours whose points moved by a point or more
    async diff(leagues, gi, now) {
      const prevBy = {}, jumps = {}, out = [];
      this.prev.forEach(l => { prevBy[l.id] = l; });
      leagues.forEach(l => {
        const pl = prevBy[l.id];
        if (!pl) return;
        const before = {};
        pl.mine.forEach(r => { before[r.id] = r.pts; });
        l.mine.forEach(r => {
          if (!(r.id in before)) return;
          const d = Math.round((r.pts - before[r.id]) * 100) / 100;
          if (Math.abs(d) >= 1) (jumps[r.id] = jumps[r.id] || { row: r, delta: d, list: [] }).list.push({ l, pl });
        });
        // the matchup just went final with you ahead
        // the matchup just went final: you won or you lost (a tie gets no screen)
        if (l.final && !pl.final && l.opp && l.my !== l.their && !this.won[l.id + ':' + l.week]) {
          this.won[l.id + ':' + l.week] = 1;
          out.push(finalMoment(l, now));
        }
      });
      return out.concat(await this.momentsFor(jumps, gi, now, (key, c, j, at, extra) => Object.assign(playMoment(key + ':' + now, c, j, at), extra)));
    }

    // the overlay's rules for which jumps pop and what they are: one moment per defensive play within this call
    // (named defenders before D/ST), plays matched to ESPN's play-by-play, small ones (under 2) only move the number
    async momentsFor(jumps, gi, now, build, summaries = {}) {     // summaries: ESPN game summaries, shared across calls
      const out = [], usedDefPlays = {};
      const order = Object.keys(jumps).sort((a, b) => (jumps[a].row.pos === 'DEF') - (jumps[b].row.pos === 'DEF'));
      for (const key of order) {
        const j = jumps[key], pid = j.row.id, p = this.players[pid] || { l: '', pos: j.row.pos, team: j.row.team }, g = FB.gameOf(p, gi);
        let plays = null;
        if (g) {
          try { summaries[g.id] = summaries[g.id] || FB.api.summary(g.id); plays = FB.playsOf(await summaries[g.id]); } catch (e) { /* no play text: classify by size */ }
        }
        if (FB.isDefense(p)) {
          // only real defensive plays pop; tackles, passes defended and points/yards-allowed swings just move the number
          const dp = j.delta > 0 && plays ? FB.defPlay(p, plays) : null;
          if (!dp || usedDefPlays[dp.text]) continue;
          usedDefPlays[dp.text] = 1;
          const d = FB.defClassify(p, dp);
          out.push(build(key, { kind: 'def', line: d.line }, j, FB.playTime(dp, now), { word: d.word, defense: true }));
          continue;
        }
        const play = plays ? FB.matchPlay(p, plays, j.delta) : null;
        const c = FB.classify(j.delta, p, play);
        if (Math.abs(j.delta) < 2 && (c.kind === 'play' || c.kind === 'bad')) continue;      // a 6-yard run or a 1-point loss isn't worth a pop
        out.push(build(key, c, j, FB.playTime(play, now), { type: play ? play.type : null }));   // ESPN's play type, for the flag
      }
      return out;
    }
  };

  function colors(gi) { const c = {}; Object.values(gi).forEach(g => g.teams.forEach(t => { c[t.abbr] = t.color; })); return c; }

  function playMoment(id, c, j, now) {
    const { l, pl } = j.list[0], r = j.row;
    return { id, at: now, kind: c.kind, line: c.line, value: j.delta, player: r, today: r.pts, before: r.pts - j.delta, proj: r.proj,
      chips: j.list.map(x => x.l.label),
      match: { label: l.label, week: l.week, me: l.me, opp: l.opp, myFrom: l.my - j.delta, myTo: l.my, their: l.their,
        pctFrom: pl.pct, pctTo: l.pct, projFrom: pl.myProj, projTo: l.myProj, theirProj: l.theirProj } };
  }
  // the record after this week (Sleeper's rosters only count it once the week is processed, so add it here)
  function finalMoment(l, now) {
    const won = l.my > l.their, r = l.record || null;
    const rec = r ? ((r.wins || 0) + (won ? 1 : 0)) + '–' + ((r.losses || 0) + (won ? 0 : 1)) : '';
    return { id: 'final:' + l.id + ':' + l.week, at: now, kind: won ? 'won' : 'lost', line: 'Final', value: l.my - l.their, chips: [l.label],
      match: { label: l.label, week: l.week, me: l.me, opp: l.opp, meLogo: l.meLogo, oppLogo: l.oppLogo,
        myFrom: l.my, myTo: l.my, their: l.their, pctFrom: 100, pctTo: 100 }, rec };
  }

  // "Show a test": a moment built from your real first starter (or a made-up one before setup)
  FB.sampleMoment = function (kind, view) {
    const l = view && view.leagues && view.leagues[0];
    const want = x => kind === 'fg' ? x.pos === 'K' : kind === 'def' ? FB.isDefense(x) && x.pos !== 'DEF' : x.pos === 'WR';
    const r = (l && (l.mine.find(want) || (kind === 'def' && l.mine.find(x => x.pos === 'DEF')) || l.mine[0])) ||
      { id: 'demo', first: 'Sample', last: 'Player', pos: kind === 'fg' ? 'K' : kind === 'def' ? 'LB' : 'WR', team: 'NYG', pts: 8.2, proj: 12.2, photo: '' };
    const delta = { td: 13.6, big: 4.0, fg: 5.0, won: 0, lost: 0, play: 2.3, bad: -2.0, def: 3.0, up: 1.4, down: -1.4, rz: 0 }[kind];
    const line = { td: '66-yd TD catch', big: '30-yd catch', fg: '50-yd FG', play: '13-yd catch', bad: 'Fumble', won: 'Final', def: 'Interception' }[kind];
    const lg = l || { label: 'League 1', week: 10, me: 'Your team', opp: 'Their team', my: 35.9, their: 30.2, pct: 56, myProj: 141, theirProj: 129.1 };
    const today = r.pts + Math.max(delta, 0);
    const m = { id: 'test:' + Date.now(), at: Date.now(), test: true, kind, line, value: delta,
      player: Object.assign({}, r, { pts: today }), today, before: today - delta, proj: r.proj == null ? 12.2 : r.proj, chips: [lg.label],
      match: { label: lg.label, week: lg.week, me: lg.me, opp: lg.opp, myFrom: lg.my, myTo: lg.my + delta, their: lg.their,
        pctFrom: lg.pct, pctTo: lg.pct == null ? null : Math.min(99, lg.pct + Math.round(delta / 2)), projFrom: lg.myProj, projTo: lg.myProj + delta, theirProj: lg.theirProj } };
    if (kind === 'def') { m.word = 'Interception'; m.defense = true; }
    if (kind === 'up' || kind === 'down' || kind === 'rz') m.quiet = true;     // under the ±2 banner threshold: only the change beside the points
    if (kind === 'rz') m.rz = true;     // no points, just the red-zone tag
    m.type = { play: 'Pass Reception', bad: 'Fumble Recovery (Opponent)' }[kind] || null;
    if (kind === 'won' || kind === 'lost') {
      return Object.assign(finalMoment(Object.assign({}, lg, { my: kind === 'won' ? Math.max(lg.my, (lg.their || 0) + 7.3) : Math.max(0, (lg.their || 0) - 7.3),
        record: lg.record || { wins: 6, losses: 3 } }), Date.now()), { id: 'test:' + Date.now(), test: true });
    }
    return m;
  };
})(globalThis.FB = globalThis.FB || {});
