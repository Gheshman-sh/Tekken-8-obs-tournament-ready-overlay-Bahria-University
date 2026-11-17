(function () {
  let state;
  const undoStack = [];
  const notice = document.getElementById('notice');
  const paths = document.querySelectorAll('[data-path]');
  let previewRequestActive = false;
  let noticeTimer;
  let lastNotice = '';
  let lastNoticeAt = 0;
  const get = (object, path) => path.split('.').reduce((value, key) => value && value[key], object);
  const set = (object, path, value) => { const keys = path.split('.'); const last = keys.pop(); const target = keys.reduce((item, key) => item[key], object); target[last] = value; };
  function notify(message, type = 'success') {
    if (type === true) type = 'error';
    const key = `${type}:${message}`;
    if (key === lastNotice && Date.now() - lastNoticeAt < (type === 'error' ? 8000 : 3500)) return;
    lastNotice = key;
    lastNoticeAt = Date.now();
    clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.className = `notice visible ${type}`;
    notice.setAttribute('role', type === 'error' ? 'alert' : 'status');
    noticeTimer = setTimeout(() => { notice.className = 'notice'; }, type === 'error' ? 8000 : 3500);
  }
  function friendlyError(message) {
    if (/replay buffer is not running/i.test(message)) return 'Replay buffer is stopped. Start the Replay Buffer in OBS before saving a replay.';
    if (/replay.*processing|ffmpeg/i.test(message)) return 'Replay processing failed. Check that FFmpeg is installed and the saved clip is available.';
    if (/replay.*not found|replay file/i.test(message)) return 'Replay operation failed. The selected replay file is unavailable.';
    if (/already in progress|sequence is already/i.test(message)) return 'Replay operation is already in progress. Wait for it to finish or stop it first.';
    if (/obs is not connected/i.test(message)) return 'OBS connection failed. Connect OBS before starting replay operations.';
    if (/ECONNREFUSED/i.test(message)) return 'OBS connection failed. Check the IP address, port, and WebSocket password.';
    return message || 'The operation failed. Please try again.';
  }
  function setButtonLoading(button, loading, label) {
    if (!button) return;
    if (loading) {
      button.dataset.originalLabel = button.textContent;
      button.disabled = true;
      button.classList.add('is-loading');
      if (label) button.textContent = label;
    } else {
      button.disabled = false;
      button.classList.remove('is-loading');
      if (button.dataset.originalLabel) {
        button.textContent = button.dataset.originalLabel;
        delete button.dataset.originalLabel;
      }
    }
  }
  function render() {
    paths.forEach(element => {
      const value = get(state, element.dataset.path);
      if (element.classList.contains('toggle')) {
        const enabled = Boolean(value);
        element.setAttribute('aria-pressed', String(enabled));
        element.classList.toggle('is-on', enabled);
        element.querySelector('b').textContent = enabled ? 'ON' : 'OFF';
      } else if (element.type === 'checkbox') element.checked = Boolean(value);
      else element.value = value == null ? '' : value;
    });
    document.querySelector('[data-score="player1"]').textContent = state.player1.score;
    document.querySelector('[data-score="player2"]').textContent = state.player2.score;
    const mode = state.broadcast && state.broadcast.mode || 'gameplay';
    const stateLabel = mode.replace('_', ' ').toUpperCase();
    document.getElementById('broadcast-state').textContent = stateLabel;
    document.getElementById('preview-state').textContent = `State: ${stateLabel}`;
    document.getElementById('client-count').textContent = state.connectedClients == null ? '—' : state.connectedClients;
    document.querySelectorAll('[data-broadcast]').forEach(button => button.classList.toggle('active', button.dataset.broadcast === mode));
    document.getElementById('undo').disabled = undoStack.length === 0;
    updateTimerDisplay();
  }
  function updateTimerDisplay() {
    const timer = state && state.broadcast && state.broadcast.timer;
    const remaining = timer ? Math.ceil(Math.max(0, timer.endsAt - Date.now()) / 1000) : 0;
    document.getElementById('broadcast-timer-remaining').textContent = remaining ? `${remaining}s → ${timer.nextMode.replace('_', ' ')}` : 'Manual';
  }
  async function save() {
    const response = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
    if (!response.ok) throw new Error((await response.json()).error || 'Unable to save state.');
    state = (await response.json()).state; render();
  }
  function snapshot() { return JSON.parse(JSON.stringify(state)); }
  function remember() { undoStack.push(snapshot()); if (undoStack.length > 20) undoStack.shift(); }
  async function action(url, options, message = 'Action completed.', button, loadingLabel = 'Working…') {
    setButtonLoading(button, true, loadingLabel);
    try {
      const response = await fetch(url, options);
      const data = response.status === 204 ? {} : await response.json();
      if (!response.ok) throw new Error(data.error);
      if (data.state) { state = data.state; render(); }
      if (data.obs) renderObs(data.obs);
      if (data.replays) renderReplays(data.replays);
      if (data.replayOperation) renderReplayOperation(data.replayOperation);
      notify(message, 'success');
      return data;
    } catch (error) {
      console.error('Control operation failed:', error);
      notify(friendlyError(error.message), 'error');
      return null;
    } finally {
      setButtonLoading(button, false);
    }
  }
  function formatObsError(message) {
    if (/ECONNREFUSED/i.test(message)) return `OBS WebSocket is not listening on port ${document.getElementById('obs-port').value}. In OBS, open Tools > WebSocket Server Settings, enable the server, and confirm the port.`;
    if (/authentication|identify/i.test(message)) return 'OBS rejected the password. Check the WebSocket Server Settings password.';
    if (/replay buffer.*not available/i.test(message)) return 'OBS reports Replay Buffer unavailable. Apply the Output setting, restart OBS, then reconnect.';
    return 'OBS reported a connection or status error. Check the OBS WebSocket settings and try again.';
  }
  function renderObs(obs) { const status = document.getElementById('obs-status'); const feedback = document.getElementById('obs-feedback'); const error = obs.error ? formatObsError(obs.error) : ''; const replayUnavailable = /replay buffer.*(not available|unavailable)/i.test(obs.error || ''); status.textContent = obs.connected ? 'Connected' : 'Disconnected'; status.className = `status-text ${obs.connected ? 'online-text' : 'offline-text'}`; feedback.textContent = obs.connected ? error ? `Connected, but: ${error}` : 'OBS WebSocket connected.' : error ? `Connection failed: ${error}` : 'Not connected to OBS.'; feedback.className = `obs-feedback ${obs.connected ? error ? 'warning-text' : 'online-text' : error ? 'offline-text' : ''}`; document.getElementById('replay-buffer').textContent = replayUnavailable ? 'Unavailable' : obs.replayBufferActive ? 'Running' : 'Stopped'; document.getElementById('stream-status').textContent = obs.streaming ? 'Live' : 'Offline'; document.getElementById('record-status').textContent = obs.recording ? 'Recording' : 'Stopped'; if (error) notify(error, true); }
  async function refreshObsPreview(button) {
    if (previewRequestActive) return;
    previewRequestActive = true;
    setButtonLoading(button, true, 'Refreshing…');
    const image = document.getElementById('obs-preview-image');
    const overlay = document.getElementById('preview');
    const empty = document.getElementById('preview-empty');
    try {
      const response = await fetch('/api/obs/preview');
      if (!response.ok) throw new Error('OBS preview unavailable.');
      const data = await response.json();
      image.src = data.imageData;
      image.hidden = false;
      overlay.hidden = true;
      empty.hidden = true;
      document.getElementById('preview-title').textContent = 'OBS Program';
      document.getElementById('preview-description').textContent = data.sceneName ? `OBS Program · ${data.sceneName}` : 'OBS Program output';
    } catch (error) {
      notify('Preview refresh failed. Showing the overlay preview instead.', 'warning');
      image.hidden = true;
      image.removeAttribute('src');
      overlay.hidden = false;
      empty.hidden = true;
      document.getElementById('preview-title').textContent = 'Program overlay';
      document.getElementById('preview-description').textContent = '1920 × 1080 transparent overlay';
    } finally {
      previewRequestActive = false;
      setButtonLoading(button, false);
    }
  }
  async function connectObs() {
    const button = document.getElementById('obs-connect');
    const feedback = document.getElementById('obs-feedback');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    button.disabled = true;
    button.textContent = 'Connecting…';
    feedback.textContent = 'Connecting to OBS WebSocket…';
    feedback.className = 'obs-feedback';
    try {
      const response = await fetch('/api/obs/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: document.getElementById('obs-address').value, port: Number(document.getElementById('obs-port').value), password: document.getElementById('obs-password').value }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'OBS connection failed.');
      renderObs(data.obs);
      notify('Connected to OBS.', 'success');
    } catch (error) {
      const message = error.name === 'AbortError' ? 'OBS connection timed out after 15 seconds. Check OBS WebSocket settings and the address.' : error.message;
      renderObs({ connected: false, replayBufferActive: false, streaming: false, recording: false, error: message });
      notify(friendlyError(message), 'error');
    } finally {
      clearTimeout(timeout);
      button.disabled = false;
      button.textContent = 'Connect';
    }
  }
  function renderReplayOperation(operation) {
    if (!operation) return;
    const status = document.getElementById('replay-operation-status');
    const busy = operation.busy;
    const labels = { idle: 'Ready', replay_intro: 'Replay Intro', saving: 'Saving', processing: 'Processing', loading: 'Loading Replay', playing: 'Playing Replay', finished: 'Finished', error: 'Error' };
    status.textContent = labels[operation.status] || operation.status.toUpperCase();
    status.className = `status ${operation.status === 'error' ? 'offline' : busy ? 'online' : operation.status === 'finished' ? 'info' : 'offline'}`;
    document.getElementById('replay-operation-message').textContent = operation.message || 'Choose a preset to save, process, and play the last 5 or 10 seconds at 0.5× speed.';
    document.querySelectorAll('[data-replay-preset], [data-replay]').forEach(button => { button.disabled = busy; });
  }
  function renderReplays(replays) {
    const library = document.getElementById('replay-library');
    if (!replays.length) { library.innerHTML = '<p class="muted">No saved replays yet.</p>'; return; }
    library.innerHTML = replays.map(item => {
      const unavailable = item.available === false;
      const title = item.presetSeconds ? `${item.presetSeconds}s slow-motion replay` : item.filename;
      const meta = `${new Date(item.createdAt).toLocaleString()} · ${escapeHtml(item.player1)} vs ${escapeHtml(item.player2)}${item.slowMotion ? ` · ${item.slowMotion}×` : ''}`;
      return `<div class="replay-item${unavailable ? ' unavailable' : ''}"><div><b>${escapeHtml(title)}</b><small>${escapeHtml(meta)}</small>${unavailable ? '<em>File unavailable</em>' : ''}</div><button class="button small primary" data-play="${escapeHtml(item.id)}"${unavailable ? ' disabled' : ''}>Play</button><button class="button small danger" data-delete="${escapeHtml(item.id)}">Delete</button></div>`;
    }).join('');
  }
  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
  function initializeCharacterAutocomplete() {
    const characters = Array.isArray(window.tekkenCharacters) ? window.tekkenCharacters : [];
    document.querySelectorAll('[data-path$=".character"]').forEach(input => {
      const wrapper = document.createElement('div');
      const menu = document.createElement('div');
      let activeIndex = -1;
      wrapper.className = 'character-autocomplete';
      menu.className = 'autocomplete-menu';
      menu.hidden = true;
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);
      wrapper.appendChild(menu);
      const close = () => { menu.hidden = true; activeIndex = -1; };
      const filtered = () => {
        const query = input.value.trim().toLowerCase();
        return characters.filter(character => character.toLowerCase().includes(query));
      };
      const choose = character => {
        input.value = character;
        close();
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const draw = () => {
        const results = filtered();
        menu.replaceChildren();
        results.forEach((character, index) => {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'autocomplete-option';
          option.textContent = character;
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false');
          option.addEventListener('mousedown', event => { event.preventDefault(); choose(character); });
          menu.appendChild(option);
        });
        menu.hidden = results.length === 0;
        activeIndex = results.length ? Math.min(activeIndex, results.length - 1) : -1;
      };
      input.addEventListener('focus', () => { activeIndex = -1; draw(); });
      input.addEventListener('input', () => { activeIndex = -1; draw(); });
      input.addEventListener('keydown', event => {
        const options = menu.querySelectorAll('.autocomplete-option');
        if (event.key === 'Escape') { close(); return; }
        if (menu.hidden || !options.length) return;
        if (event.key === 'ArrowDown') { event.preventDefault(); activeIndex = (activeIndex + 1) % options.length; }
        else if (event.key === 'ArrowUp') { event.preventDefault(); activeIndex = (activeIndex - 1 + options.length) % options.length; }
        else if (event.key === 'Enter' && activeIndex >= 0) { event.preventDefault(); choose(options[activeIndex].textContent); return; }
        options.forEach((option, index) => option.setAttribute('aria-selected', index === activeIndex ? 'true' : 'false'));
      });
      document.addEventListener('mousedown', event => { if (!wrapper.contains(event.target)) close(); });
    });
  }
  initializeCharacterAutocomplete();
  paths.forEach(element => element.addEventListener('change', async () => { const value = element.type === 'checkbox' ? element.checked : element.type === 'number' ? Number(element.value) : element.value; remember(); set(state, element.dataset.path, value); try { await save(); notify('Settings saved.'); } catch (error) { notify(friendlyError(error.message), 'error'); } }));
  document.querySelectorAll('.toggle').forEach(button => button.addEventListener('click', async () => { remember(); set(state, button.dataset.path, !get(state, button.dataset.path)); try { await save(); notify('Setting saved.'); } catch (error) { notify(friendlyError(error.message), 'error'); } }));
  document.querySelectorAll('[data-score-action]').forEach(button => button.addEventListener('click', async () => { const [player, delta] = button.dataset.scoreAction.split(':'); remember(); state[player].score = Math.max(0, state[player].score + Number(delta)); try { await save(); notify('Score updated.'); } catch (error) { notify(friendlyError(error.message), 'error'); } }));
  document.getElementById('swap').onclick = async () => { remember(); [state.player1, state.player2] = [state.player2, state.player1]; try { await save(); notify('Player sides swapped.'); } catch (error) { notify(friendlyError(error.message), 'error'); } };
  document.getElementById('next-game').onclick = async () => { remember(); state.gameNumber = Number(state.gameNumber || 1) + 1; try { await save(); notify('Next game started.'); } catch (error) { notify(friendlyError(error.message), 'error'); } };
  document.getElementById('reset-scores').onclick = async () => { remember(); state.player1.score = 0; state.player2.score = 0; try { await save(); notify('Scores reset.'); } catch (error) { notify(friendlyError(error.message), 'error'); } };
  document.getElementById('clear-match').onclick = async () => { if (!window.confirm('Clear the current match data?')) return; remember(); state.player1 = { name: '', character: '', score: 0 }; state.player2 = { name: '', character: '', score: 0 }; try { await save(); notify('Match cleared.'); } catch (error) { notify(friendlyError(error.message), 'error'); } };
  document.getElementById('undo').onclick = async () => { const previous = undoStack.pop(); if (!previous) return; state = previous; try { await save(); notify('Last action undone.'); } catch (error) { notify(friendlyError(error.message), 'error'); } };
  document.querySelectorAll('[data-broadcast]').forEach(button => button.onclick = () => action(`/api/broadcast/${button.dataset.broadcast}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ winner: button.dataset.winner ? Number(button.dataset.winner) : null }) }, `${button.textContent} started.`, button));
  document.querySelectorAll('[data-timer-action]').forEach(button => button.onclick = () => action('/api/broadcast/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: button.dataset.timerAction }) }, 'Broadcast timer updated.', button));
  document.getElementById('refresh-preview').onclick = event => refreshObsPreview(event.currentTarget);
  document.querySelectorAll('[data-replay]').forEach(button => button.onclick = () => action(`/api/replay/${button.dataset.replay}`, { method: 'POST' }, 'Replay control updated.', button));
  document.querySelectorAll('[data-replay-preset]').forEach(button => button.onclick = () => action('/api/replay/preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds: Number(button.dataset.replayPreset) }) }, `Starting ${button.dataset.replayPreset}s replay.`, button, 'Starting…'));
  document.getElementById('obs-connect').onclick = connectObs;
  document.getElementById('obs-disconnect').onclick = event => action('/api/obs/disconnect', { method: 'POST' }, 'Disconnected from OBS.', event.currentTarget, 'Disconnecting…');
  document.getElementById('replay-library').onclick = event => {
    const play = event.target.closest('[data-play]');
    const remove = event.target.closest('[data-delete]');
    if (play) action('/api/replay/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: play.dataset.play }) }, 'Replay sequence started.', play, 'Loading…');
    if (remove) action(`/api/replays/${remove.dataset.delete}`, { method: 'DELETE' }, 'Replay deleted successfully.', remove, 'Deleting…');
  };
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`); socket.onmessage = event => { const message = JSON.parse(event.data); if (message.state) { state = message.state; render(); } if (message.obs) renderObs(message.obs); if (message.replays) renderReplays(message.replays); if (message.replayOperation) renderReplayOperation(message.replayOperation); };
  Promise.all([fetch('/api/state').then(response => response.json()), fetch('/api/network').then(response => response.json())]).then(([data, network]) => { state = data.state; render(); renderObs(data.obs); renderReplays(data.replays); renderReplayOperation(data.state.replayOperation); document.getElementById('obs-address').value = state.obs.address; document.getElementById('obs-port').value = state.obs.port; document.getElementById('network-addresses').textContent = `LAN: ${(network.addresses || []).join(', ') || 'localhost'}:${network.port}`; refreshObsPreview(); }).catch(error => notify(friendlyError(error.message), 'error'));
  setInterval(refreshObsPreview, 2000);
  setInterval(updateTimerDisplay, 250);
}());
