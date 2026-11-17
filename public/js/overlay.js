(function () {
  const overlay = document.getElementById('overlay');
  const video = document.getElementById('replay-video');
  const set = (key, value) => document.querySelectorAll(`[data-bind="${key}"]`).forEach(element => { element.textContent = value === null || value === undefined ? '' : String(value); });
  let activeReplayUrl = '';
  let previousMode = '';
  let statusRequest = Promise.resolve();

  function reportReplayStatus(status, message) {
    statusRequest = statusRequest.then(() => fetch('/api/replay/browser-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, message })
    })).catch(() => {});
    return statusRequest;
  }

  function hideReplayVideo() {
    video.pause();
    video.removeAttribute('src');
    video.load();
    activeReplayUrl = '';
  }

  function playReplay(url) {
    if (!url || url === activeReplayUrl) return;
    activeReplayUrl = url;
    video.pause();
    video.src = url;
    video.load();
    reportReplayStatus('loading');
  }

  function render(state) {
    const settings = state.settings || {};
    const broadcast = state.broadcast || { mode: state.replayActive ? 'replay' : 'gameplay' };
    const mode = state.replayActive ? 'replay' : broadcast.mode;
    const winner = broadcast.winner === 2 ? state.player2 : state.player1;
    if (mode !== previousMode) {
      overlay.dataset.mode = '';
      requestAnimationFrame(() => { overlay.dataset.mode = mode; });
      previousMode = mode;
    } else {
      overlay.dataset.mode = mode;
    }
    set('tournament', state.tournamentName || 'BAHRIA UNIVERSITY ESPORTS SHOWDOWN');
    set('round', state.roundName);
    set('format', state.format);
    set('game', `GAME ${state.gameNumber}`);
    set('p1Name', state.player1.name); set('p1Character', settings.showCharacters ? state.player1.character : '');
    set('p1Score', state.player1.score); set('p2Name', state.player2.name);
    set('p2Character', settings.showCharacters ? state.player2.character : ''); set('p2Score', state.player2.score);
    set('winnerName', winner.name); set('winnerCharacter', winner.character);
    overlay.classList.toggle('show-players', settings.showPlayers !== false);
    overlay.classList.toggle('no-animations', settings.animationsEnabled === false);
    document.querySelector('.replay-badge').hidden = !(settings.showReplayIndicator && (mode === 'replay' || mode === 'replay_intro'));
    if (state.replayActive && state.activeReplay) playReplay(new URL(state.activeReplay.url, location.href).href);
    if (!state.replayActive && mode !== 'replay') hideReplayVideo();
  }

  video.addEventListener('canplay', () => {
    video.play().catch(error => reportReplayStatus('error', `Replay could not start: ${error.message}`));
  });
  video.addEventListener('playing', () => reportReplayStatus('playing'));
  video.addEventListener('ended', () => {
    hideReplayVideo();
    fetch('/api/replay/browser-ended', { method: 'POST' }).catch(() => {});
  });
  video.addEventListener('error', () => {
    reportReplayStatus('error', 'Replay video could not be loaded in the OBS Browser Source.');
  });

  function connect() {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.state) render(message.state);
      if (message.type === 'replay' && message.active && message.replay) {
        overlay.dataset.mode = 'replay';
        playReplay(new URL(message.replay.url, location.href).href);
      }
      if (message.type === 'replay' && !message.active) hideReplayVideo();
    };
    socket.onclose = () => setTimeout(connect, 1500);
  }
  fetch('/api/state').then(response => response.json()).then(data => render(data.state)).catch(console.error);
  connect();
}());
