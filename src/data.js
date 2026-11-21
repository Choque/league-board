// Network: Sleeper (leagues, live points, projections) and ESPN (game state, play-by-play).
// In the extension every call goes through background.js; in the dev harness it's a plain fetch (both APIs allow CORS *).
(function (FB) {
  'use strict';
  const S = 'https://api.sleeper.app', E = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
  const POS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'].map(p => 'position%5B%5D=' + p).join('&');
  const inExt = () => typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  function ask(msg) {
    return new Promise((ok, no) => chrome.runtime.sendMessage(msg, r => {
      if (chrome.runtime.lastError) return no(new Error(chrome.runtime.lastError.message));
      return r && !r.error ? ok(r.data) : no(new Error(r ? r.error : 'no reply'));
    }));
  }
  const get = url => inExt() ? ask({ type: 'fetch', url })
    : fetch(url, { cache: 'no-cache' }).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status + ' ' + url)));

  function slimPlayers(all) {     // same shape background.js stores
    const out = {};
    for (const [id, p] of Object.entries(all || {})) {
      if (p && p.position) out[id] = { f: p.first_name || '', l: p.last_name || '', pos: p.position, team: p.team || (p.position === 'DEF' ? id : '') };
    }
    return out;
  }

  FB.api = {
    state: () => get(S + '/v1/state/nfl'),
    user: name => get(S + '/v1/user/' + encodeURIComponent(String(name).replace(/^@/, '').trim())),
    leagues: (uid, season) => get(`${S}/v1/user/${uid}/leagues/nfl/${season}`),
    league: id => get(`${S}/v1/league/${id}`),
    rosters: id => get(`${S}/v1/league/${id}/rosters`),
    users: id => get(`${S}/v1/league/${id}/users`),
    matchups: (id, week) => get(`${S}/v1/league/${id}/matchups/${week}`),
    // undocumented but open; one row per player: {player_id, stats: {pts_ppr, pts_half_ppr, pts_std, ...}}
    projections: (season, week) => get(`${S}/projections/nfl/${season}/${week}?season_type=regular&${POS}`),
    // the same rows with live stat lines; Sleeper refreshes it every few seconds, the league points only about once a minute
    stats: (season, week) => get(`${S}/stats/nfl/${season}/${week}?season_type=regular&${POS}`),
    scoreboard: () => get(E + '/scoreboard'),
    summary: id => get(E + '/summary?event=' + id),
    players: () => inExt() ? ask({ type: 'players' }) : get(S + '/v1/players/nfl').then(slimPlayers),
  };

  // ESPN game summary -> plays, oldest first: the scoring list, then the last few drives (current one last)
  // `off` is the team that had the ball (ESPN abbreviation): a D/ST's plays are the ones where it didn't
  FB.playsOf = function (s) {
    const out = [], abbr = {};
    const hc = s && s.header && s.header.competitions && s.header.competitions[0];
    ((hc && hc.competitors) || []).forEach(c => { abbr[c.team.id] = c.team.abbreviation; });
    const teamOf = p => (p.start && p.start.team && abbr[p.start.team.id]) || (p.team && abbr[p.team.id]) || null;
    const d = (s && s.drives) || {}, all = (d.previous || []).concat(d.current ? [d.current] : []), when = {};
    all.forEach(dr => (dr.plays || []).forEach(p => { if (p.id && p.wallclock) when[p.id] = Date.parse(p.wallclock) || null; }));
    (s && s.scoringPlays || []).forEach(p => out.push({ type: (p.type && p.type.text) || '', text: p.text || '', scoring: true, off: null, at: when[p.id] || null }));
    all.slice(-4).forEach(dr => (dr.plays || []).forEach(p => out.push({
      type: (p.type && p.type.text) || '', text: p.text || '', yds: p.statYardage, scoring: !!p.scoringPlay, off: teamOf(p), at: when[p.id] || null })));
    return out;
  };

  FB.photo = (id, pos) => pos === 'DEF' ? `https://sleepercdn.com/images/team_logos/nfl/${String(id).toLowerCase()}.png`
    : `https://sleepercdn.com/content/nfl/players/thumb/${id}.jpg`;
})(globalThis.FB = globalThis.FB || {});
