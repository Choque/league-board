// ?demo: scripted plays for checking the board without a live game. With ?demo&league=<id> it loads that league's real
// matchups, teams and starters from Sleeper once, then scripts plays on top; plain ?demo uses made-up data (no network).
// A view every 5 s and a scoring play every ~9 s: touchdown, big play, small play, defense, lost points.
(function (FB) {
  'use strict';
  // made-up teams: [name, projected], pairs in order, and team a's win %
  const TEAMS = [['Harbor City Hammers', 156.15], ['Two-Point Conversions', 135.05], ['Cedar Falls Comets', 134.63], ['Blitz Brigade', 140.58],
    ['Fourth & Forever', 152.02], ['Lakeside Lumberjacks', 143.48], ['Red Zone Raccoons', 129.11], ['Snap Count Society', 141.08],
    ['The Bye Week Blues', 139.97], ['Hail Mary Hornets', 131.30]];
  const PCT = [63, 46, 56, 42, 56];
  const NAMES = [['Josh', 'Allen', 'QB', 'BUF'], ['Bijan', 'Robinson', 'RB', 'ATL'], ['Ja\'Marr', 'Chase', 'WR', 'CIN'], ['Trey', 'McBride', 'TE', 'ARI'],
    ['Jahmyr', 'Gibbs', 'RB', 'DET'], ['Puka', 'Nacua', 'WR', 'LAR'], ['Lamar', 'Jackson', 'QB', 'BAL'], ['Brock', 'Bowers', 'TE', 'LV'],
    ['Derrick', 'Henry', 'RB', 'BAL'], ['Justin', 'Jefferson', 'WR', 'MIN'], ['Joe', 'Burrow', 'QB', 'CIN'], ['George', 'Kittle', 'TE', 'SF'],
    ['Saquon', 'Barkley', 'RB', 'PHI'], ['CeeDee', 'Lamb', 'WR', 'DAL'], ['Jalen', 'Hurts', 'QB', 'PHI'], ['Sam', 'LaPorta', 'TE', 'DET'],
    ['Kyren', 'Williams', 'RB', 'LAR'], ['Amon-Ra', 'St. Brown', 'WR', 'DET'], ['Baker', 'Mayfield', 'QB', 'TB'], ['Mark', 'Andrews', 'TE', 'BAL']];
  const INJ = { 3: { short: 'QUES', q: true }, 11: { short: 'OUT', q: false } };
  const KINDS = [['td', 7.4, 'Touchdown', '22-yd TD catch'], ['big', 4.2, null, '34-yd catch'], ['play', 2.3, null, '12-yd run'],
    ['def', 2, 'Interception', 'Interception'], ['bad', -2, null, 'Fumble']];

  FB.BoardDemo = class {
    constructor(out) { this.out = out; this.n = 0; }
    async configure(s) {
      const real = s && s.leagueId ? await this.load(s.leagueId).catch(e => { console.warn('[demo] no real league, made-up data instead', e); return null; }) : null;
      this.label = real ? real.label : 'Demo League';
      this.week = real ? real.week : 12;
      this.pct = real ? real.matchups.map(m => m.pctA) : PCT;
      this.ids = real ? real.matchups.map(m => m.id) : null;     // keep Sleeper's matchup numbers, so ?matchups= works in the demo too
      this.teams = real ? this.fromLeague(real) : this.madeUp();
      this.teams.forEach(t => { t.start = this.score(t); });
      this.emit();
      clearInterval(this.t);
      this.t = setInterval(() => this.tick(), 4500);
    }
    // one poll of the real league mode: real names, logos, starters (photos, injury tags), projections, win %
    async load(id) {
      let v = null;
      const e = new FB.LeagueEngine({ view: x => { v = x; }, moment() {}, status() {} });
      e.start = () => {};
      await e.configure({ leagueId: id });
      await e.tick();
      if (!v || !v.leagues[0] || !v.leagues[0].matchups.length) throw new Error('no matchups this week');
      return v.leagues[0];
    }
    // the real starters, with 2 to 4 per team pretending to be in live games (about half of those on the field)
    fromLeague(l) {
      return l.matchups.flatMap(m => [m.a, m.b]).map((t, k) => ({ roster: t.roster, name: t.name, proj: t.proj, logo: t.logo,
        rows: t.rows.map((r, i) => { const live = i < 2 + (k % 3); return Object.assign({}, r, { live, field: live && (i + k) % 2 === 0, game: live ? 'Q2 5:00' : r.game }); }) }));
    }
    madeUp() {
      // 10 rosters of 6 starters, 2 to 4 of them in live games, about half of those on the field
      return TEAMS.map(([name, proj], t) => ({ roster: t + 1, name, proj, logo: '', rows: Array.from({ length: 6 }, (_, i) => {
        const [first, last, pos, team] = NAMES[(t * 3 + i) % NAMES.length];
        const live = i < 2 + (t % 3), id = 'd' + t + '-' + i;
        return { id, first, last, pos, team, pts: Math.round(Math.random() * 1500) / 100, proj: 12, live, field: live && (i + t) % 2 === 0,
          rz: live && i === 0 && t % 4 === 0, photo: '', inj: INJ[(t * 6 + i) % 13] || null, game: live ? 'Q2 5:00' : 'Sun 19:00' };
      }) }));
    }
    pause() {} resume() {} stop() { clearInterval(this.t); }
    score(t) { return Math.round(t.rows.reduce((s, r) => s + r.pts, 0) * 100) / 100; }
    emit(at) {
      const matchups = Array.from({ length: this.teams.length / 2 }, (_, i) => {
        const a = this.teams[i * 2], b = this.teams[i * 2 + 1], team = t => ({ roster: t.roster, name: t.name, logo: t.logo, score: this.score(t),
          proj: Math.round((t.proj + this.score(t) - t.start) * 100) / 100, rows: t.rows.map(r => Object.assign({}, r)),
          toPlay: t.rows.filter(r => !r.live).length, done: 0 });
        const A = team(a), B = team(b);
        const swing = (A.score - a.start) - (B.score - b.start);     // points gained since the start move the win % off Sleeper's
        return { id: this.ids ? this.ids[i] : i + 1, a: A, b: B, pctA: Math.max(1, Math.min(99, Math.round(this.pct[i] + swing))) };
      });
      this.out.view({ at: at || Date.now(), week: this.week, leagues: [{ id: 'demo', label: this.label, week: this.week, matchups, liveGames: 4 }], colors: {} });
      return matchups;
    }
    tick() {
      this.n++;
      if (this.n % 2) return this.emit();     // every other tick just a view (the field flips)
      const [kind, value, word, line] = KINDS[(this.n / 2 - 1) % KINDS.length];
      const t = this.teams[Math.floor(Math.random() * this.teams.length)], r = t.rows.find(x => x.live) || t.rows[0], at = Date.now();
      const before = this.score(t);
      r.pts = Math.round((r.pts + value) * 100) / 100;
      t.rows.forEach(x => { if (x.live) x.field = !x.field; });
      const ms = this.emit(at), m = ms.find(x => x.a.roster === t.roster || x.b.roster === t.roster);
      const side = m.a.roster === t.roster ? 'a' : 'b', other = side === 'a' ? 'b' : 'a';
      console.log('[demo] moment', kind, t.name, new Date(at).toISOString());
      this.out.moment({ id: 'demo:' + at, at, kind, line, value, word: kind === 'def' ? word : undefined, defense: kind === 'def',
        player: Object.assign({}, r), team: { roster: t.roster, name: t.name },
        matchup: { id: m.id, a: { roster: m.a.roster, name: m.a.name, score: m.a.score }, b: { roster: m.b.roster, name: m.b.name, score: m.b.score },
          before: { [side]: before, [other]: m[other].score } } });
    }
  };
})(globalThis.FB = globalThis.FB || {});
