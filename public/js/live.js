// live.html: the live link (docs/LIVE_LINK.md, D-96).
//
// Shows one group's live game, or its leaderboard between games, on any
// screen with a browser. No sign-in: the page calls live_board(token) with the
// publishable key and listens on the private Realtime channel live:<token>,
// which the database feeds beside the group's own channel. It follows the
// viewer's rules from docs/LIVE_GAME.md: the score comes from the latest
// `game` event, the board is read again after every (re)join and match
// change, and "Reconnecting…" covers whatever was last shown until it has.
//
// Realtime is spoken directly over a websocket (Phoenix's protocol: join,
// heartbeat, broadcast), so the page has no dependencies and nothing to
// build, like the rest of the site.
(function () {
  // The hosted Supabase project (pickleball-app/docs/PRODUCTION.md, D-125):
  // its custom domain and publishable key, which is public by design; the
  // database's access rules do the protecting. For the local stack, open the
  // page once with ?api=<url>&key=<publishable key> and it remembers them.
  const PRODUCTION = { api: 'https://api.getpickleballers.app', key: 'sb_publishable_MLUSE-jqOspvij85rRfZLg_WFiSYP-3' };
  // The App Store link, once there is one. Until then the QR code carries
  // this page's own link, so people can follow on their phones.
  const APP_STORE_URL = '';

  const token = (location.hash || '').slice(1).toLowerCase();
  const config = resolveConfig();

  const els = {
    name: document.getElementById('group-name'),
    status: document.getElementById('status'),
    main: document.getElementById('main'),
    overlay: document.getElementById('overlay'),
    overlayText: document.getElementById('overlay-text'),
  };

  // What the page knows.
  let board = null;            // the last live_board, or null before the first read
  let linkDead = false;        // live_board said there's no such link
  let joined = false;          // the channel is joined
  let readSince = false;       // the board was read since the channel was joined
  let lastFinal = null;        // { match, game, at }: a game that just ended, kept 20 s
  let wakeLock = null;
  let clockOffset = 0;         // this device's clock minus the server's, from the last read
  let clockOffsetSet = false;
  let ticking = null;          // the elapsed-time ticker while a game is on

  function resolveConfig() {
    const params = new URLSearchParams(location.search);
    let api = params.get('api');
    let key = params.get('key');
    try {
      if (api && key) {
        localStorage.setItem('liveLinkApi', api);
        localStorage.setItem('liveLinkKey', key);
      } else {
        api = localStorage.getItem('liveLinkApi');
        key = localStorage.getItem('liveLinkKey');
      }
    } catch (e) { /* private mode: fall through */ }
    if (!api || !key) ({ api, key } = PRODUCTION);
    return api && key ? { api: api.replace(/\/$/, ''), key } : null;
  }

  // ---------------------------------------------------------------------------
  // Reading the board
  // ---------------------------------------------------------------------------

  let readTimer = null;
  let readsStarted = 0;        // to drop a read that lands after a newer one
  let readsApplied = 0;
  let recentGames = [];        // { at, payload }: `game` events of the last minute
  async function readBoard() {
    if (!config || !token) return;
    clearTimeout(readTimer);
    const n = ++readsStarted;
    const sent = Date.now();
    try {
      const res = await fetch(`${config.api}/rest/v1/rpc/live_board`, {
        method: 'POST',
        headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_token: token }),
      });
      // A 4xx/5xx says nothing about the link: keep what's shown, retry.
      if (!res.ok) throw new Error(`live_board: ${res.status}`);
      const next = await res.json();
      if (n < readsApplied) return;
      readsApplied = n;
      if (next === null) {
        // The only answer that means the link is gone.
        linkDead = true;
        stopListening();
      } else {
        const wasDead = linkDead;
        board = next;
        linkDead = false;
        // A score that arrived while this read was on its way is newer than
        // (or the same as) what it read, so it goes back on top.
        for (const e of recentGames) if (e.at >= sent) applyGame(e.payload);
        if (next.as_of) {
          // The server's clock at the middle of the round trip.
          const offset = (sent + Date.now()) / 2 - Date.parse(next.as_of);
          if (!clockOffsetSet || Math.abs(offset - clockOffset) > 1000) clockOffset = offset;
          clockOffsetSet = true;
        }
        if (wasDead) connect();
      }
      if (n >= joinRead) readSince = true;
    } catch (e) {
      // Keep what's shown; try again soon.
      clearTimeout(readTimer);
      readTimer = setTimeout(readBoard, 5000);
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Hearing changes
  // ---------------------------------------------------------------------------

  let ws = null;
  let heartbeat = null;
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let ref = 0;
  let heardCount = 0;          // messages from the server on this socket
  let joinRead = 0;            // the first read started after the last join

  function connect() {
    if (!config || !token || linkDead || ws) return;
    clearTimeout(reconnectTimer);
    const url = config.api.replace(/^http/, 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent(config.key)}&vsn=1.0.0`;
    let socket;
    try { socket = new WebSocket(url); } catch (e) { retry(); return; }
    ws = socket;
    socket.onopen = () => {
      send(socket, `realtime:live:${token}`, 'phx_join', {
        config: { broadcast: { self: false }, presence: { key: '' }, private: true },
        access_token: config.key,
      });
      // A heartbeat the server never answers means the connection is dead
      // even if the socket says otherwise (a sleeping TV, a dropped Wi-Fi).
      clearInterval(heartbeat);
      heartbeat = setInterval(() => ping(socket, 15000), 15000);
      // A join that's never answered is as good as a dead connection.
      setTimeout(() => { if (ws === socket && !joined) drop(socket); }, 20000);
    };
    socket.onmessage = (m) => {
      if (ws !== socket) return;
      heardCount += 1;         // anything from the server says it's there
      let d;
      try { d = JSON.parse(m.data); } catch (e) { return; }
      if (d.event === 'phx_reply' && d.topic === `realtime:live:${token}`) {
        if (d.payload && d.payload.status === 'ok') {
          joined = true;
          readSince = false;
          reconnectDelay = 1000;
          joinRead = readsStarted + 1;
          readBoard();
        } else {
          // Refused. Realtime refuses a link that's gone ("Unauthorized"),
          // but also for passing reasons (a rate limit, the database busy).
          // live_board says which: null means gone; anything else, retry.
          drop(socket);
          readBoard();
        }
      } else if (d.event === 'broadcast' && d.payload) {
        heard(d.payload.event, d.payload.payload);
      } else if ((d.event === 'phx_error' || d.event === 'phx_close') && d.topic !== 'phoenix') {
        drop(socket);
      }
    };
    socket.onclose = () => drop(socket);
    socket.onerror = () => drop(socket);
  }

  // A heartbeat, and the connection is given up if nothing at all comes back
  // within `wait`.
  function ping(socket, wait) {
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    const before = heardCount;
    send(socket, 'phoenix', 'heartbeat', {});
    setTimeout(() => { if (ws === socket && heardCount === before) drop(socket); }, wait);
  }

  // Lets go of a socket that closed, failed, was refused or stopped
  // answering, shows "Reconnecting…", and tries again. It doesn't wait for
  // the socket's own close: on a connection that died quietly the browser
  // can take minutes to report one.
  function drop(socket) {
    if (ws !== socket) return;
    ws = null;
    clearInterval(heartbeat);
    joined = false;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try { socket.close(); } catch (e) { /* already closed */ }
    render();
    retry();
  }

  function retry() {
    clearTimeout(reconnectTimer);
    if (linkDead) return;
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  }

  // The link is gone: stop listening on it.
  function stopListening() {
    clearTimeout(reconnectTimer);
    if (ws) drop(ws);
  }

  function send(socket, topic, event, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ topic, event, payload, ref: String(++ref) }));
  }

  // Puts a `game` event's score on its match. False if the match isn't on
  // the board (a match that started since the last read).
  function applyGame(payload) {
    const match = board && board.matches.find((m) => m.id === payload.match_id);
    if (!match) return null;
    const i = match.games.findIndex((g) => g.id === payload.id);
    if (i >= 0) match.games[i] = payload; else match.games.push(payload);
    match.games.sort((a, b) => a.game_number - b.game_number);
    return match;
  }

  function heard(event, payload) {
    if (event === 'game') {
      const now = Date.now();
      recentGames = recentGames.filter((e) => now - e.at < 60000);
      recentGames.push({ at: now, payload });
      const match = applyGame(payload);
      if (!match) { readBoard(); return; }
      if (payload.status === 'final') {
        lastFinal = { match, game: payload, at: now };
        // When the 20 seconds are up, the leaderboard, read fresh so it has
        // the new numbers if the replay was slower than the 5 s read below.
        setTimeout(readBoard, 20500);
      }
      render();
    } else if (event === 'match') {
      readBoard();
      // The rating replay fills in the new numbers a few seconds after a
      // match is confirmed.
      if (payload.status === 'confirmed') setTimeout(readBoard, 5000);
    } else if (event === 'gone') {
      // The Owner reset or turned off the link (sent on the old topic by
      // set_live_link, 20261029000000_live_link_gone.sql). The read confirms
      // it: only a null board marks the link dead, so a stray event can't.
      readBoard();
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  function render() {
    fitRows.pending = false;
    if (!config) {
      setStatus('', false);
      els.main.innerHTML = message('This page isn\'t set up yet.',
        'Open it once as <code>live.html?api=&lt;url&gt;&amp;key=&lt;key&gt;#&lt;token&gt;</code> and it remembers.');
      overlay(false);
      return;
    }
    if (!token || linkDead) {
      els.name.textContent = '';
      setStatus('', false);
      els.main.innerHTML = message('This link isn\'t live anymore.', 'Ask the group\'s organizer for a new one.');
      overlay(false);
      stopTicking();
      keepAwake(false);
      drawQR();
      return;
    }
    overlay(!(joined && readSince), 'Reconnecting…');
    drawQR();
    if (!board) return;

    els.name.textContent = board.group.name;
    const live = board.matches.filter((m) => currentGame(m));
    if (live.length) {
      lastFinal = null;        // a game is on: the last one's Final is old news
      setStatus('Live', true, live.length);
      // Up to eight games at once: one fills the screen, two sit across,
      // three or four go two by two (the leaderboard takes the fourth cell
      // beside three), five to eight four by two; the boards shrink to fit.
      const shown = live.slice(-8);
      const count = shown.length > 4 ? 'eight' : shown.length > 2 ? 'four' : shown.length > 1 ? 'two' : 'one';
      const standings = shown.length === 3 ? standingsHTML(board.standings, true) : '';
      els.main.innerHTML = `<div class="boards ${count}">${shown.map((m) => boardHTML(m)).join('')}${standings}</div>`
        + (live.length > 8 ? `<div class="more">and ${live.length - 8} more game${live.length > 9 ? 's' : ''} on</div>` : '');
      startTicking(shown);
      keepAwake(true);
      if (standings) fitRows();
    } else if (lastFinal && Date.now() - lastFinal.at < 20000) {
      stopTicking();
      setStatus('Final', false);
      els.main.innerHTML = `<div class="boards">${boardHTML(lastFinal.match, lastFinal.game)}</div>`;
      keepAwake(true);
    } else {
      stopTicking();
      setStatus('No game on right now', false);
      els.main.innerHTML = standingsHTML(board.standings);
      keepAwake(false);
      fitRows();
    }
    fitText();
  }

  // "Live", "Live · 3 games", "Final" or "No game on right now".
  function setStatus(text, live, count) {
    els.status.textContent = text;
    if (live && count > 1) els.status.innerHTML = `Live<span class="count">· ${count} games</span>`;
    els.status.classList.toggle('live', live);
  }

  // How long the match has been going, as the prototype's Live Game page
  // shows it: m:ss, next to the Live dot (one game), or on each board (two).
  function elapsed(match) {
    const ms = Date.now() - clockOffset - Date.parse(match.started_at);
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(sec).padStart(2, '0');
  }
  function tick(shown) {
    if (shown.length === 1) {
      const html = `Live<span class="clock">${elapsed(shown[0])}</span>`;
      if (els.status.innerHTML !== html) els.status.innerHTML = html;
    } else {
      els.main.querySelectorAll('.board .clock').forEach((el, i) => { if (shown[i]) el.textContent = elapsed(shown[i]); });
    }
  }
  // Four times a second, so the clock turns over on the second whenever the
  // boards were last drawn, not up to a second late.
  let tickingShown = [];
  function startTicking(shown) {
    tickingShown = shown;
    tick(shown);
    if (!ticking) ticking = setInterval(() => tick(tickingShown), 250);
  }
  function stopTicking() {
    clearInterval(ticking);
    ticking = null;
  }

  function overlay(show, text) {
    els.overlay.hidden = !show;
    if (text) els.overlayText.textContent = text;
  }

  function message(title, sub) {
    return `<div class="message"><p>${title}</p><p class="sub">${sub}</p></div>`;
  }

  // The game being played: the one in progress, else none.
  function currentGame(match) {
    return match.games.find((g) => g.status === 'in_progress') || null;
  }

  function boardHTML(match, game) {
    const g = game || currentGame(match);
    const doubles = match.team_a.length === 2;
    const serving = g.serving_team;
    const receiving = serving === 'A' ? 'B' : 'A';
    const score = (t) => (t === 'A' ? g.team_a_score : g.team_b_score);
    const team = (t) => (t === 'A' ? match.team_a : match.team_b);
    const final = g.status === 'final';
    const wins = { A: 0, B: 0 };
    for (const x of match.games) if (x.winning_team) wins[x.winning_team]++;
    const needed = match.format === 'best_of_5' ? 3 : match.format === 'best_of_3' ? 2 : 1;
    const dash = '<span class="dash">–</span>';

    // The call: each number its own span, the dashes in the third gray.
    let call;
    if (final) {
      const w = g.winning_team;
      call = `<span>${score(w)}</span>${dash}<span class="lost">${score(w === 'A' ? 'B' : 'A')}</span>`;
    } else if (!serving) {
      call = `<span>0</span>${dash}<span>0</span>`;
    } else {
      call = `<span>${score(serving)}</span>${dash}<span>${score(receiving)}</span>` + (doubles && g.server_number ? `${dash}<span>${g.server_number}</span>` : '');
    }

    // The line over the call: Live with its dot (on every board when there
    // are several), the game of a match, the games won, Game point, and the
    // clock at the far end.
    const several = !game && board.matches.filter((m) => currentGame(m)).length > 1;
    let top = '';
    if (final) top += '<span>Final</span>';
    else if (several) top += '<span class="live-mark">Live</span>';
    if (needed > 1) {
      top += `<span>Game ${g.game_number} of ${needed * 2 - 1}</span>`;
      // Games won so far, in the team colors: the rows below say whose is whose.
      if (wins.A || wins.B) top += `<span class="games"><b class="a">${wins.A}</b>–<b class="b">${wins.B}</b></span>`;
    }
    if (!final && serving && isGamePoint(g, serving)) {
      const decides = needed > 1 && wins[serving] + 1 >= needed;
      top += `<span class="tag">${decides ? 'Match point' : 'Game point'}</span>`;
    }
    if (several) top += '<span class="clock"></span>';

    // Under the call: the winners on a final, "Starting…" before the first
    // serve; while a game is on, the ball beside the server says it all.
    let line = '';
    if (final) {
      const w = g.winning_team;
      const decided = wins[w] >= needed;
      line = `${esc(teamName(team(w)))} ${decided && needed > 1 ? 'win the match' : doubles ? 'win' : 'wins'}`;
    } else if (!serving) {
      line = 'Starting…';
    }

    // The leading score in ink, the trailing one in the secondary gray;
    // tied, both in ink. On a final the losers' is gray.
    const a = score('A'), b = score('B');
    const trail = (t) => (final ? g.winning_team !== t : (t === 'A' ? a < b : b < a));
    const row = (t) => {
      const won = final && g.winning_team === t;
      return `<div class="team ${t.toLowerCase()}${!final && serving === t ? ' serving' : ''}${won ? ' won' : ''}">
        <span class="stripe"></span>
        <div class="names">${team(t).map((p) => `<span class="name"><span class="slot">${!final && g.server_player_id === p.id ? '<span class="ball"></span>' : ''}</span>${esc(p.name)}</span>`).join('')}</div>
        <div class="points${trail(t) ? ' trail' : ''}">${score(t)}</div>
      </div>`;
    };

    return `<section class="board${final ? ' final' : ''}">
      <div class="board-top">${top}</div>
      <div class="call">${call}</div>
      <div class="line">${line}</div>
      <div class="teams">${row('A')}${row('B')}</div>
    </section>`;
  }

  // The serving team wins the game with one more point. Not once the score
  // already decides it (11-2 while the scorer hasn't confirmed the game yet):
  // that isn't game point any more, and the Final follows on confirm.
  function isGamePoint(g, serving) {
    const wins = (a, b) => a >= g.points_to_win && a - b >= g.win_by;
    const now = serving === 'A' ? g.team_a_score : g.team_b_score;
    const theirs = serving === 'A' ? g.team_b_score : g.team_a_score;
    if (wins(now, theirs) || wins(theirs, now)) return false;
    return wins(now + 1, theirs);
  }

  function teamName(players) { return players.map((p) => p.name).join(' & '); }

  // The leaderboard: the screen between games, or a board beside three live
  // games (`asBoard`). A number that went up is green with its +; down is
  // the label color with its −, never red.
  function standingsHTML(rows, asBoard) {
    if (!rows.length) {
      if (asBoard) return '<section class="board standings"><div class="standings-title">Leaderboard</div><div class="rows"></div></section>';
      return message('No one is ranked yet.', 'Players show up here after a few games.');
    }
    const title = '<div class="standings-title"><span>Leaderboard</span><span class="key">+/− · W–L</span></div>';
    const list = `<div class="rows">${rows.map((r, i) => `
      <div class="row${i === 0 ? ' first' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="name">${esc(r.name)}</span>
        <span class="number ${r.number > 0 ? 'up' : ''}">${plusMinus(r.number)}</span>
        <span class="record">${r.wins}–${r.losses}</span>
      </div>`).join('')}</div>`;
    return asBoard
      ? `<section class="board standings">${title}${list}</section>`
      : `<div class="standings">${title}${list}</div>`;
  }

  // The leaderboard in the biggest type that fits: a short list grows (up to
  // twice the base size) while every row still fits and no name is cut; a
  // long one keeps the base size and drops rows from the bottom, never
  // leaving half a row. A name that's still too wide shrinks rather than
  // being cut. Beside three live games the list keeps its base size.
  function fitRows() {
    const list = els.main.querySelector('.rows');
    if (!list || !list.firstElementChild) return;
    if (list.closest('.board')) {
      let guard = 200;
      while (list.scrollHeight > list.clientHeight + 1 && list.children.length > 1 && guard--) list.removeChild(list.lastElementChild);
      return;
    }
    const over = () => list.scrollHeight > list.clientHeight + 1;
    const cut = () => [...list.querySelectorAll('.name')].some((n) => n.scrollWidth > n.clientWidth + 1);
    const base = parseFloat(getComputedStyle(list.firstElementChild).fontSize);
    let size = base;
    for (let k = 2; k > 1; k -= 0.05) {
      list.style.setProperty('--row-size', `${base * k}px`);
      if (!over() && !cut()) { size = base * k; break; }
    }
    list.style.setProperty('--row-size', `${size}px`);
    let guard = 200;
    while (over() && list.children.length > 1 && guard--) {
      list.removeChild(list.lastElementChild);
    }
    for (const n of list.querySelectorAll('.name')) {
      if (n.scrollWidth > n.clientWidth + 1) n.style.fontSize = `${Math.max(0.6, (n.clientWidth / n.scrollWidth) * 0.98)}em`;
    }
  }

  // A name on a board, or the group's name, that is still too wide for its
  // line after the stylesheet's caps (a 20-letter first name, a 60-letter
  // group name on a phone) shrinks, down to 0.6 of its size, rather than
  // ending in "…". The leaderboard's names get the same in fitRows.
  function fitText() {
    for (const n of els.main.querySelectorAll('.board .name')) {
      n.style.fontSize = '';
      if (n.scrollWidth > n.clientWidth + 1) n.style.fontSize = `${Math.max(0.6, (n.clientWidth / n.scrollWidth) * 0.98)}em`;
    }
    // In px of its own size: an em here would be of the header's 16 px.
    const g = els.name;
    g.style.fontSize = '';
    const base = parseFloat(getComputedStyle(g).fontSize);
    let k = 1;
    while ((g.scrollHeight > g.clientHeight + 2 || g.scrollWidth > g.clientWidth + 1) && k > 0.6) {
      k -= 0.05;
      g.style.fontSize = `${base * k}px`;
    }
  }

  function plusMinus(n) {
    const fixed = Math.abs(n).toFixed(1);
    if (fixed === '0.0') return '0.0';
    return (n > 0 ? '+' : '−') + fixed;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------------
  // Staying awake, staying current
  // ---------------------------------------------------------------------------

  // One request or release at a time: render() runs several times a second
  // around a tap, and two overlapping requests would leave a lock nobody
  // releases, keeping the screen on over the leaderboard.
  let wakeWanted = false;
  let wakeBusy = false;
  let wakeRefused = false;     // the browser said no; ask again when the tab is back
  async function keepAwake(on) {
    wakeWanted = on;
    if (wakeBusy) return;
    wakeBusy = true;
    try {
      for (;;) {
        if (wakeWanted && !wakeLock && !wakeRefused && navigator.wakeLock && document.visibilityState === 'visible') {
          const lock = await navigator.wakeLock.request('screen');
          lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
          wakeLock = lock;
        } else if (!wakeWanted && wakeLock) {
          const lock = wakeLock;
          wakeLock = null;
          await lock.release();
        } else break;
      }
    } catch (e) {
      wakeRefused = true;
    } finally {
      wakeBusy = false;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // A TV or iPad waking up: read the board, and check the connection
      // now rather than at the next heartbeat (the socket may have died
      // while it slept without saying so).
      wakeRefused = false;
      readBoard();
      if (ws && joined) ping(ws, 5000);
      connect();
      render();
    }
  });
  // The QR code, when the screen has room for it (a TV, a laptop, an iPad
  // on a stand; not a phone). It needs about 8 cm to scan from a few metres.
  let qrFor = null;
  function drawQR() {
    const qr = document.getElementById('qr');
    const roomy = window.innerWidth >= 900 && window.innerHeight >= 520;
    if (!roomy || !token || linkDead || !config) {
      qr.hidden = true;
      document.body.classList.remove('has-qr');
      return;
    }
    const target = APP_STORE_URL || `${location.origin}${location.pathname}#${token}`;
    if (qrFor !== target) {
      try {
        document.getElementById('qr-code').innerHTML = window.QR.svg(target);
        qrFor = target;
      } catch (e) { qr.hidden = true; return; }
    }
    document.getElementById('qr-caption').textContent = APP_STORE_URL ? 'Scan to get the app' : 'Scan to follow along on your phone';
    qr.hidden = false;
    document.body.classList.add('has-qr');
  }

  window.addEventListener('resize', () => { drawQR(); if (els.main.querySelector('.rows')) render(); else fitText(); });
  setInterval(readBoard, 60000);

  render();
  readBoard();
  connect();
})();
