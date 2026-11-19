(function () {
  const overlay = document.getElementById('overlay');
  const video = document.getElementById('replay-video');
  const set = (key, value) => document.querySelectorAll(`[data-bind="${key}"]`).forEach(element => { element.textContent = value === null || value === undefined ? '' : String(value); });
  let activeReplayUrl = '';
  let previousMode = '';
  let transitionToken = 0;
  let activeMode = '';
  let latestState = null;
  let transitionStatus = 'idle';
  let transitionFallbackTimer = 0;
  const previousScores = { p1: null, p2: null };
  const activeAnimations = new Set();
  const stateElements = {
    gameplay: () => document.querySelector('.state-gameplay'),
    replay: () => document.querySelector('.state-gameplay'),
    match_intro: () => document.querySelector('.state-intro'),
    game_transition: () => document.querySelector('.state-transition'),
    winner: () => document.querySelector('.state-winner'),
    standby: () => document.querySelector('.state-standby'),
    special_guest: () => document.querySelector('.state-special-guest'),
    replay_intro: () => document.querySelector('.state-replay-intro')
  };
  const presetKeyframes = (preset, direction) => {
    const entering = direction === 'in';
    switch (preset) {
      case 'slide-left':
        return entering ? [{ transform: 'translateX(5%)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }] : [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-5%)', opacity: 0 }];
      case 'slide-right':
        return entering ? [{ transform: 'translateX(-5%)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }] : [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(5%)', opacity: 0 }];
      case 'slide-up':
        return entering ? [{ transform: 'translateY(5%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }] : [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-5%)', opacity: 0 }];
      case 'slide-down':
        return entering ? [{ transform: 'translateY(-5%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }] : [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(5%)', opacity: 0 }];
      case 'zoom-in':
        return entering ? [{ transform: 'scale(.94)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }] : [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.94)', opacity: 0 }];
      case 'zoom-out':
        return entering ? [{ transform: 'scale(1.06)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }] : [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.06)', opacity: 0 }];
      case 'wipe':
        return entering ? [{ clipPath: 'inset(0 100% 0 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }] : [{ clipPath: 'inset(0 0 0 0)', opacity: 1 }, { clipPath: 'inset(0 0 0 100%)', opacity: 1 }];
      case 'cinematic':
        return entering ? [{ opacity: 0, filter: 'blur(8px)', transform: 'scale(1.025)' }, { opacity: 1, filter: 'blur(0)', transform: 'scale(1)' }] : [{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(5px)', transform: 'scale(.985)' }];
      default:
        return entering ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }];
    }
  };
  function transitionConfig(state, mode) {
    const globalSettings = state.transitionSettings || {};
    const override = state.transitionOverrides && state.transitionOverrides[mode];
    const preset = typeof override === 'string' && override ? override : (globalSettings.preset || 'cinematic');
    return {
      preset,
      duration: Math.max(100, Math.min(5000, Number(globalSettings.duration) || 700)),
      easing: globalSettings.easing || 'cubic-bezier(.22,.61,.36,1)',
      entrance: globalSettings.entrance || preset,
      exit: globalSettings.exit || preset
    };
  }
  function normalDisplay(element) {
    if (!element) return '';
    if (element.classList.contains('state-standby') ||
        element.classList.contains('state-special-guest') ||
        element.classList.contains('state-replay-intro')) return 'flex';
    return 'block';
  }

  function cancelActiveTransition(cleanMode) {
    transitionToken++;
    transitionStatus = 'completed';
    clearTimeout(transitionFallbackTimer);
    activeAnimations.forEach(animation => animation.cancel());
    activeAnimations.clear();
    document.querySelectorAll('.state').forEach(element => {
      element.style.removeProperty('display');
      element.style.removeProperty('z-index');
      element.classList.remove('transition-force-visible');
    });
    overlay.dataset.mode = cleanMode || activeMode || 'gameplay';
    activeMode = cleanMode || activeMode || 'gameplay';
    transitionStatus = 'idle';
  }

  function finishTransition(token, cleanMode) {
    if (token !== transitionToken) return;
    cancelActiveTransition(cleanMode);
  }

  function transitionTo(state, oldMode, newMode) {
    cancelActiveTransition(oldMode);
    const outgoing = stateElements[oldMode] && stateElements[oldMode]();
    const incoming = stateElements[newMode] && stateElements[newMode]();
    const config = transitionConfig(state, newMode);
    const token = ++transitionToken;
    activeMode = newMode;
    previousMode = newMode;
    transitionStatus = 'exiting';

    if (!incoming) {
      overlay.dataset.mode = newMode;
      finishTransition(token, newMode);
      return;
    }

    overlay.dataset.mode = newMode;
    incoming.style.display = normalDisplay(incoming);
    incoming.style.zIndex = '3';
    if (outgoing && outgoing !== incoming) {
      outgoing.style.display = normalDisplay(outgoing);
      outgoing.style.zIndex = '2';
    }

    const exitDuration = Math.round(config.duration * .42);
    const entranceDuration = config.duration - exitDuration;

    if (!outgoing || outgoing === incoming) {
      transitionStatus = 'entering';
      const entrance = incoming.animate(presetKeyframes(config.entrance || config.preset, 'in'), {
        duration: entranceDuration,
        easing: config.easing,
        fill: 'both'
      });
      activeAnimations.add(entrance);
      entrance.finished.catch(() => {}).finally(() => activeAnimations.delete(entrance));
    } else {
      const exit = outgoing.animate(presetKeyframes(config.exit || config.preset, 'out'), {
        duration: exitDuration,
        easing: config.easing,
        fill: 'both'
      });
      activeAnimations.add(exit);
      exit.finished.catch(() => {}).finally(() => {
        activeAnimations.delete(exit);
        if (token === transitionToken) outgoing.style.removeProperty('display');
        if (token === transitionToken) outgoing.style.removeProperty('z-index');
      });

      transitionStatus = 'entering';
      const entrance = incoming.animate(presetKeyframes(config.entrance || config.preset, 'in'), {
        duration: entranceDuration,
        easing: config.easing,
        fill: 'both',
        delay: exitDuration
      });
      activeAnimations.add(entrance);
      entrance.finished.catch(() => {}).finally(() => activeAnimations.delete(entrance));
    }

    transitionFallbackTimer = setTimeout(() => finishTransition(token, newMode), config.duration + 180);
  }
  let statusRequest = Promise.resolve();

  function reportReplayStatus(status, message) {
    statusRequest = statusRequest.then(() => fetch('/api/replay/browser-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, message })
    })).catch(() => { });
    return statusRequest;
  }

  function hideReplayVideo() {
    video.pause();
    video.removeAttribute('src');
    video.load();
    activeReplayUrl = '';
  }

  function setSource(key, value) {
    document.querySelectorAll(`[data-bind-src="${key}"]`).forEach(element => {
      if (value) {
        element.src = value;
        element.parentElement.classList.add('has-photo');
      } else {
        element.removeAttribute('src');
        element.parentElement.classList.remove('has-photo');
      }
    });
  }

  function playReplay(url) {
    if (!url || url === activeReplayUrl) return;
    activeReplayUrl = url;
    video.pause();
    video.src = url;
    video.load();
    reportReplayStatus('loading');
  }

  function renderScoreIndicators(playerKey, triangles) {
    const row = document.querySelector(`[data-score-row="${playerKey}"]`);
    if (!row) return;
    const previous = previousScores[playerKey];
    const safeScore = Math.max(0, Math.min(3, Number(triangles) || 0));

    row.replaceChildren();
    for (let index = 0; index < 3; index++) {
      const marker = document.createElement('span');
      marker.className = `win-marker${index < safeScore ? ' won' : ''}`;
      if (index < safeScore && (previous === null || index >= previous)) {
        marker.classList.add('won');
      }
      row.appendChild(marker);
    }
    previousScores[playerKey] = safeScore;
  }

  // Long names step down in size by length so they never clip in the fixed-width name panel.
  // Class-based (not measured) so it is correct even while the gameplay state is hidden.
  function fitName(key, name) {
    const length = String(name || '').length;
    const cls = length > 22 ? 'len-xl' : length > 16 ? 'len-lg' : length > 12 ? 'len-md' : '';
    document.querySelectorAll(`.state-gameplay [data-bind="${key}"]`).forEach(element => {
      element.classList.remove('len-md', 'len-lg', 'len-xl');
      if (cls) element.classList.add(cls);
    });
  }

  // Brief pop on the score digit when it changes (skipped on first render).
  const lastScoreShown = { p1: null, p2: null };
  function bumpScore(playerKey, score) {
    const value = Number(score) || 0;
    const previous = lastScoreShown[playerKey];
    lastScoreShown[playerKey] = value;
    if (previous === null || previous === value) return;
    const element = document.querySelector(`.state-gameplay .${playerKey}-score span`);
    if (!element) return;
    element.classList.remove('score-bump');
    void element.offsetWidth;
    element.classList.add('score-bump');
  }

  function render(state) {
    latestState = state;
    const settings = state.settings || {};
    const broadcast = state.broadcast || { mode: state.replayActive ? 'replay' : 'gameplay' };
    const mode = state.replayActive ? 'replay' : broadcast.mode;
    const winner = broadcast.winner === 2 ? state.player2 : state.player1;
    if (mode !== previousMode) {
      if (!previousMode) {
        cancelActiveTransition(mode);
        overlay.dataset.mode = mode;
        activeMode = mode;
        previousMode = mode;
      } else if (settings.animationsEnabled !== false) {
        transitionTo(state, previousMode, mode);
      } else {
        cancelActiveTransition(mode);
        overlay.dataset.mode = mode;
        previousMode = mode;
        activeMode = mode;
      }
    } else {
      if (activeMode && activeMode !== mode) cancelActiveTransition(mode);
      overlay.dataset.mode = mode;
    }
    set('tournament', state.tournamentName || 'BAHRIA UNIVERSITY ESPORTS SHOWDOWN');
    set('round', state.roundName);
    set('roundTime', state.roundTime ? `${state.roundTime}s` : '');
    set('game', `GAME ${state.gameNumber}`);
    set('matchFormat', state.matchFormat || 'MATCH');
    set('p1Name', state.player1.name); set('p1Character', settings.showCharacters ? state.player1.character : '');
    set('p1Score', state.player1.score); set('p2Name', state.player2.name);
    set('p2Character', settings.showCharacters ? state.player2.character : ''); set('p2Score', state.player2.score);
    fitName('p1Name', state.player1.name); fitName('p2Name', state.player2.name);
    bumpScore('p1', state.player1.score); bumpScore('p2', state.player2.score);
    renderScoreIndicators('p1', state.player1.triangles);
    renderScoreIndicators('p2', state.player2.triangles);
    set('winnerName', winner.name); set('winnerCharacter', winner.character);
    const guest = state.specialGuest || {};
    set('guestName', guest.name || 'Special Guest');
    set('guestTitle', guest.title || '');
    set('guestOrganization', guest.organization || '');
    set('guestSubtitle', guest.subtitle || 'BAHRIA UNIVERSITY ESPORTS SHOWDOWN');
    setSource('guestPhoto', guest.photo || '');
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
    fetch('/api/replay/browser-ended', { method: 'POST' }).catch(() => { });
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
        if (activeMode !== 'replay') {
          transitionTo(latestState || {}, activeMode || previousMode || 'gameplay', 'replay');
        }
        playReplay(new URL(message.replay.url, location.href).href);
      }
      if (message.type === 'replay' && !message.active) hideReplayVideo();
      if (message.type === 'transitionPreview') {
        const activeElement = document.querySelector('.overlay .state') && Array.from(document.querySelectorAll('.overlay .state')).find(element => getComputedStyle(element).display !== 'none');
        if (activeElement) {
          const previewAnimation = activeElement.animate(presetKeyframes(message.preset || 'cinematic', 'in'), {
            duration: Number(message.duration) || 700,
            easing: message.easing || 'cubic-bezier(.22,.61,.36,1)'
          });
          activeAnimations.add(previewAnimation);
          previewAnimation.finished.catch(() => {}).finally(() => activeAnimations.delete(previewAnimation));
        }
      }
    };
    socket.onclose = () => setTimeout(connect, 1500);
  }
  fetch('/api/state').then(response => response.json()).then(data => render(data.state)).catch(console.error);
  connect();
}());