// League mode for the watch-party board: every matchup of one league, and a moment for every team's plays.
// Same polling, rows and moment rules as the overlay's engine (FB.Engine); only what it builds per poll differs.
(function (FB) {
  'use strict';
  const r2 = v => Math.round(v * 100) / 100;

  FB.LeagueEngine = class extends FB.Engine {
    async configure(s) {
      this.stop();
      this.meta = null; this.prev = null;
      if (!s.leagueId) return;
      const id = s.leagueId;
      const [league, rosters, users] = await Promise.all([FB.api.league(id), FB.api.rosters(id), FB.api.users(id)]);
      if (!league) throw new Error('League not found: ' + id);
      const { names, logos } = FB.teamNames(rosters || [], users || []);
      this.meta = [{ id, name: league.name, scoring: league.scoring_settings || null, roster: null, names, logos, record: null }];
      this.start();
    }

    // all matchups of the league; a bye (no matchup id) or a lone roster isn't shown
    league(m, mu, gi, week) {
      const by = {};
      mu.forEach(x => { if (x.matchup_id != null) (by[x.matchup_id] = by[x.matchup_id] || []).push(x); });
      const team = (x, s) => {
        const state = r => { const g = FB.gameOf(r, gi); return g ? g.state : null; };
        return { roster: x.roster_id, name: m.names[x.roster_id] || 'Team ' + x.roster_id, logo: m.logos[x.roster_id] || '',
          score: s.total, proj: s.side.total, rows: s.rows,
          toPlay: s.rows.filter(r => state(r) === 'pre').length, done: s.rows.filter(r => state(r) === 'post').length };
      };
      const matchups = Object.keys(by).map(Number).sort((a, b) => a - b).filter(id => by[id].length === 2).map(id => {
        const [x, y] = by[id].sort((p, q) => p.roster_id - q.roster_id), sx = this.sideOf(m, x, gi), sy = this.sideOf(m, y, gi);
        return { id, a: team(x, sx), b: team(y, sy), pctA: FB.winPct(sx.side, sy.side) };
      });
      const liveGames = new Set(Object.values(gi).filter(g => g.state === 'in')).size;     // gi lists each game under both teams
      return { id: m.id, label: m.name, week, matchups, liveGames };
    }

    // every starter in the league whose points moved by a point or more; the defense rule runs per team, so one
    // interception can pop for team A's linebacker and team B's D/ST
    async diff(leagues, gi, now) {
      const was = {}, out = [], summaries = {};
      (this.prev[0] ? this.prev[0].matchups : []).forEach(mt => [mt.a, mt.b].forEach(t => { was[t.roster] = t; }));
      for (const mt of (leagues[0] ? leagues[0].matchups : [])) {
        for (const [side, other] of [['a', 'b'], ['b', 'a']]) {
          const t = mt[side], before = {}, jumps = {};
          if (!was[t.roster]) continue;
          was[t.roster].rows.forEach(r => { before[r.id] = r.pts; });
          t.rows.forEach(r => {
            if (!(r.id in before)) return;
            const d = r2(r.pts - before[r.id]);
            if (Math.abs(d) >= 1) jumps[t.roster + ':' + r.id] = { row: r, delta: d, list: [] };
          });
          const build = (key, c, j, at, extra) => Object.assign({ id: 'b:' + key + ':' + now, at, kind: c.kind, line: c.line, value: j.delta,
            player: j.row, team: { roster: t.roster, name: t.name },
            matchup: { id: mt.id, a: { roster: mt.a.roster, name: mt.a.name, score: mt.a.score }, b: { roster: mt.b.roster, name: mt.b.name, score: mt.b.score },
              before: { [side]: r2(t.score - j.delta), [other]: mt[other].score } } }, extra);
          out.push(...await this.momentsFor(jumps, gi, now, build, summaries));
        }
      }
      return out;
    }
  };

  // A card's rows for one team: on the field, then who scored in the last minute, then the rest of the live players by
  // points; nobody else (the "to play · done" line covers them). Field and starred stay put, the rest pages evenly.
  FB.boardRows = function (rows, max, page, starred) {
    const field = rows.filter(r => r.field), star = rows.filter(r => !r.field && starred.has(r.id));
    const live = rows.filter(r => !r.field && !starred.has(r.id) && r.live).sort((a, b) => b.pts - a.pts);
    const pinned = field.concat(star), N = max > 0 ? max : Infinity;
    const chunk = (list, size) => {      // 7 in 4 rows -> 4 + 3, as FB.pageRows splits
      const n = Math.ceil(list.length / size), even = Math.ceil(list.length / n), i = page % n;
      return { part: list.slice(i * even, i * even + even), n };
    };
    if (pinned.length + live.length <= N) return { shown: pinned.concat(live), pages: 1 };
    const c = pinned.length >= N ? chunk(pinned.concat(live), N) : chunk(live, N - pinned.length);
    return { shown: pinned.length >= N ? c.part : pinned.concat(c.part), pages: c.n };
  };

  // The banner's second line, from the scoring team's side: "Badgers take the lead, 91.60–83.20"
  FB.matchupLine = function (m) {
    const mt = m.matchup, me = m.team.roster === mt.a.roster ? 'a' : 'b', them = me === 'a' ? 'b' : 'a';
    const S = mt[me].name, O = mt[them].name, s = mt[me].score, s0 = mt.before[me], o = mt[them].score, f = FB.f2;
    if (s > o && s0 <= o) return `${S} take the lead, ${f(s)}–${f(o)}`;
    if (s > o) return `${S} lead ${O} ${f(s)}–${f(o)}`;
    if (s === o) return `${S} tie ${O} at ${f(s)}`;
    return `${S} trail ${O} ${f(s)}–${f(o)}`;
  };
})(globalThis.FB = globalThis.FB || {});
