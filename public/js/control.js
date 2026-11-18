(function () {
  let state;
  const undoStack = [];
  const notice = document.getElementById('notice');
  const paths = document.querySelectorAll('[data-path]');
  let previewRequestActive = false;
  let saveQueue = Promise.resolve();
  let socketReconnectTimer;
  let noticeTimer;
  let lastNotice = '';
  let lastNoticeAt = 0;
  let guestProfiles = [];
  let selectedGuestProfileId = '';
  let rememberObsCredentials = false;
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
      if (element === document.activeElement) return;
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
    document.querySelectorAll('[data-transition-state]').forEach(select => {
      select.value = get(state.transitionOverrides || {}, select.dataset.transitionState) || '';
    });
    document.getElementById('undo').disabled = undoStack.length === 0;
    updateTimerDisplay();
  }
  function updateTimerDisplay() {
    const timer = state && state.broadcast && state.broadcast.timer;
    const remaining = timer ? Math.ceil(Math.max(0, timer.endsAt - Date.now()) / 1000) : 0;
    document.getElementById('broadcast-timer-remaining').textContent = remaining ? `${remaining}s → ${timer.nextMode.replace('_', ' ')}` : 'Manual';
  }
  async function save() {
    const snapshot = JSON.stringify(state);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const response = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: snapshot });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to save state.');
      state = data.state;
      render();
    });
    await saveQueue;
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
  window.updatePreviewStatus = event => {
    const xhr = event.detail && event.detail.xhr;
    const empty = document.getElementById('preview-empty');
    if (!xhr) {
      empty.hidden = false;
      empty.textContent = 'Preview status unavailable';
      return;
    }
    if (xhr.status === 200) {
      const scene = xhr.getResponseHeader('X-OBS-Scene');
      const previewStatus = xhr.getResponseHeader('X-OBS-Preview');
      if (previewStatus) {
        empty.hidden = false;
        empty.textContent = previewStatus === 'disconnected' ? 'OBS disconnected — showing the local overlay preview' : 'OBS preview error — showing the local overlay preview';
        document.getElementById('preview-title').textContent = 'Program overlay';
        document.getElementById('preview-description').textContent = '1920 × 1080 transparent overlay';
        return;
      }
      empty.hidden = true;
      document.getElementById('preview-title').textContent = 'OBS Program';
      document.getElementById('preview-description').textContent = scene ? `OBS Program · ${scene}` : 'OBS Program output';
    } else {
      empty.hidden = false;
      empty.textContent = 'OBS unavailable — showing the local overlay preview';
      document.getElementById('preview-title').textContent = 'Program overlay';
      document.getElementById('preview-description').textContent = '1920 × 1080 transparent overlay';
    }
  };
  window.updatePreviewLoading = () => {
    const empty = document.getElementById('preview-empty');
    empty.hidden = false;
    empty.textContent = 'Refreshing OBS preview…';
  };
  async function connectObs() {
    const button = document.getElementById('obs-connect');
    const feedback = document.getElementById('obs-feedback');
    const address = document.getElementById('obs-address').value;
    const port = Number(document.getElementById('obs-port').value);
    const password = document.getElementById('obs-password').value;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    button.disabled = true;
    button.textContent = 'Connecting…';
    feedback.textContent = 'Connecting to OBS WebSocket…';
    feedback.className = 'obs-feedback';
    try {
      if (rememberObsCredentials) {
        await fetch('/api/obs/credentials', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remember: true, address, port, password }) });
      }
      const response = await fetch('/api/obs/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address, port, password }), signal: controller.signal });
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
  const presentationSequence = ['gameplay', 'match_intro', 'game_transition', 'winner', 'standby', 'special_guest'];
  function isEditableTarget(target) {
    return target instanceof HTMLElement && (
      target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT'
    );
  }
  async function activatePresentation(mode, winner) {
    await action(`/api/broadcast/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ winner: winner || null })
    }, `${mode.replace('_', ' ').replace(/\b\w/g, character => character.toUpperCase())} started.`);
  }
  function activateRelativePresentation(direction) {
    const current = state && state.broadcast && state.broadcast.mode || 'gameplay';
    let currentIndex = presentationSequence.indexOf(current);
    if (currentIndex < 0) currentIndex = 0;
    const nextIndex = (currentIndex + direction + presentationSequence.length) % presentationSequence.length;
    activatePresentation(presentationSequence[nextIndex]);
  }
  document.addEventListener('keydown', event => {
    if (!event.ctrlKey || event.altKey || event.repeat || isEditableTarget(event.target)) return;
    const key = event.key.toLowerCase();
    let handled = true;
    switch (key) {
      case '[': activateRelativePresentation(-1); break;
      case ']': activateRelativePresentation(1); break;
      case '1': activatePresentation('gameplay'); break;
      case '2': activatePresentation('match_intro'); break;
      case '3': activatePresentation('game_transition'); break;
      case '4': activatePresentation('winner', 1); break;
      case '5': activatePresentation('winner', 2); break;
      case '6': activatePresentation('standby'); break;
      case '7': activatePresentation('special_guest'); break;
      case 'z':
        if (!undoStack.length) handled = false;
        else document.getElementById('undo').click();
        break;
      default: handled = false;
    }
    if (handled) event.preventDefault();
  });
  function renderGuestProfiles(profiles) {
    guestProfiles = Array.isArray(profiles) ? profiles : [];
    const select = document.getElementById('guest-profile-select');
    const selected = selectedGuestProfileId;
    select.replaceChildren(new Option('Select saved guest…', ''));
    guestProfiles.forEach(profile => select.appendChild(new Option(profile.name, profile.id)));
    select.value = guestProfiles.some(profile => profile.id === selected) ? selected : '';
  }
  async function refreshGuestProfiles() {
    try {
      const response = await fetch('/api/guest-profiles');
      const data = await response.json();
      if (response.ok) renderGuestProfiles(data.profiles);
    } catch (error) {
      notify('Saved guest profiles could not be loaded.', 'error');
    }
  }
  function setRememberObsButton(enabled) {
    rememberObsCredentials = enabled;
    const button = document.getElementById('remember-obs');
    button.classList.toggle('is-on', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.querySelector('b').textContent = enabled ? 'ON' : 'OFF';
  }
  async function loadObsCredentials() {
    try {
      const response = await fetch('/api/obs/credentials');
      const data = await response.json();
      if (!response.ok) return;
      document.getElementById('obs-address').value = data.address || '127.0.0.1';
      document.getElementById('obs-port').value = data.port || 4455;
      setRememberObsButton(Boolean(data.remember));
    } catch (error) {
      console.error('Unable to restore OBS settings:', error);
    }
  }
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
  document.querySelectorAll('[data-transition-state]').forEach(select => select.addEventListener('change', async () => {
    remember();
    if (!state.transitionOverrides) state.transitionOverrides = {};
    state.transitionOverrides[select.dataset.transitionState] = select.value || null;
    try { await save(); notify('State transition override saved.'); } catch (error) { notify(friendlyError(error.message), 'error'); }
  }));
  document.getElementById('guest-photo-file').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      remember();
      state.specialGuest = state.specialGuest || {};
      state.specialGuest.photo = String(reader.result || '');
      try { await save(); notify('Guest photograph saved.'); } catch (error) { notify(friendlyError(error.message), 'error'); }
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('guest-profile-select').addEventListener('change', event => {
    selectedGuestProfileId = event.target.value;
  });
  document.getElementById('guest-profile-load').addEventListener('click', async () => {
    const profile = guestProfiles.find(item => item.id === selectedGuestProfileId);
    if (!profile) { notify('Select a saved guest first.', 'warning'); return; }
    remember();
    state.specialGuest = {
      name: profile.name || '',
      title: profile.title || '',
      organization: profile.organization || '',
      subtitle: profile.subtitle || '',
      photo: profile.photo || ''
    };
    try { await save(); notify(`${profile.name} loaded.`, 'success'); } catch (error) { notify(friendlyError(error.message), 'error'); }
  });
  document.getElementById('guest-profile-save').addEventListener('click', async () => {
    const guest = state.specialGuest || {};
    if (!String(guest.name || '').trim()) { notify('Enter a guest name before saving.', 'warning'); return; }
    const profile = { id: selectedGuestProfileId || '', name: guest.name, title: guest.title, organization: guest.organization, subtitle: guest.subtitle, photo: guest.photo };
    try {
      const response = await fetch('/api/guest-profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      renderGuestProfiles(data.profiles);
      const saved = data.profiles.find(item => item.name === profile.name && (!profile.id || item.id === profile.id));
      if (saved) selectedGuestProfileId = saved.id;
      document.getElementById('guest-profile-select').value = selectedGuestProfileId;
      notify('Guest profile saved.', 'success');
    } catch (error) { notify(friendlyError(error.message), 'error'); }
  });
  document.getElementById('guest-profile-new').addEventListener('click', () => {
    selectedGuestProfileId = '';
    document.getElementById('guest-profile-select').value = '';
    state.specialGuest = { name: '', title: '', organization: '', subtitle: '', photo: '' };
    document.getElementById('guest-photo-file').value = '';
    render();
  });
  document.getElementById('guest-profile-delete').addEventListener('click', async () => {
    if (!selectedGuestProfileId) { notify('Select a saved guest first.', 'warning'); return; }
    const profile = guestProfiles.find(item => item.id === selectedGuestProfileId);
    if (!profile || !window.confirm(`Delete the saved profile for ${profile.name}?`)) return;
    try {
      const response = await fetch(`/api/guest-profiles/${encodeURIComponent(selectedGuestProfileId)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      selectedGuestProfileId = '';
      renderGuestProfiles(data.profiles);
      notify('Guest profile deleted.', 'success');
    } catch (error) { notify(friendlyError(error.message), 'error'); }
  });
  document.getElementById('toggle-obs-password').addEventListener('click', event => {
    const input = document.getElementById('obs-password');
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    event.currentTarget.textContent = hidden ? 'Hide' : 'Show';
    event.currentTarget.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
    event.currentTarget.setAttribute('aria-pressed', String(hidden));
  });
  document.getElementById('remember-obs').addEventListener('click', async event => {
    rememberObsCredentials = !rememberObsCredentials;
    setRememberObsButton(rememberObsCredentials);
    const address = document.getElementById('obs-address').value;
    const port = Number(document.getElementById('obs-port').value);
    const password = document.getElementById('obs-password').value;
    try {
      const response = await fetch('/api/obs/credentials', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remember: rememberObsCredentials, address, port, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      notify(rememberObsCredentials ? 'OBS credentials will be restored securely.' : 'Remembered OBS credentials removed.', 'success');
    } catch (error) { notify(friendlyError(error.message), 'error'); }
  });
  document.getElementById('preview-transition').addEventListener('click', async () => {
    await action('/api/broadcast/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preset: state.transitionSettings.preset,
        duration: state.transitionSettings.duration,
        easing: state.transitionSettings.easing
      })
    }, 'Transition preview sent.', document.getElementById('preview-transition'));
  });
  document.getElementById('restore-transition-defaults').addEventListener('click', async () => {
    remember();
    state.transitionSettings = { preset: 'cinematic', duration: 700, easing: 'cubic-bezier(.22,.61,.36,1)', entrance: 'zoom-in', exit: 'fade' };
    state.transitionOverrides = { gameplay: null, match_intro: null, game_transition: null, winner: null, standby: null, special_guest: null };
    try { await save(); notify('Animation settings restored.'); } catch (error) { notify(friendlyError(error.message), 'error'); }
  });
  paths.forEach(element => element.addEventListener('change', async () => { const value = element.type === 'checkbox' ? element.checked : element.type === 'number' ? Number(element.value) : element.value; remember(); set(state, element.dataset.path, value); try { await save(); notify('Settings saved.'); } catch (error) { notify(friendlyError(error.message), 'error'); } }));
  document.querySelectorAll('.toggle').forEach(button => button.addEventListener('click', async () => { remember(); set(state, button.dataset.path, !get(state, button.dataset.path)); try { await save(); notify('Setting saved.'); } catch (error) { notify(friendlyError(error.message), 'error'); } }));
  document.querySelectorAll('[data-score-action]').forEach(button => button.addEventListener('click', async () => { const [player, delta] = button.dataset.scoreAction.split(':'); remember(); state[player].score = Math.max(0, state[player].score + Number(delta)); try { await save(); notify('Score updated.'); } catch (error) { notify(friendlyError(error.message), 'error'); } }));
  document.getElementById('swap').onclick = async () => { remember();[state.player1, state.player2] = [state.player2, state.player1]; try { await save(); notify('Player sides swapped.'); } catch (error) { notify(friendlyError(error.message), 'error'); } };
  document.getElementById('next-game').onclick = async () => { remember(); state.gameNumber = Number(state.gameNumber || 1) + 1; try { await save(); notify('Next game started.'); } catch (error) { notify(friendlyError(error.message), 'error'); } };
  document.getElementById('reset-scores').onclick = async () => { remember(); state.player1.score = 0; state.player2.score = 0; try { await save(); notify('Scores reset.'); } catch (error) { notify(friendlyError(error.message), 'error'); } };
  document.getElementById('clear-match').onclick = async () => { if (!window.confirm('Clear the current match data?')) return; remember(); state.player1 = { name: '', character: '', score: 0 }; state.player2 = { name: '', character: '', score: 0 }; try { await save(); notify('Match cleared.'); } catch (error) { notify(friendlyError(error.message), 'error'); } };
  document.getElementById('undo').onclick = async () => { const previous = undoStack.pop(); if (!previous) return; state = previous; try { await save(); notify('Last action undone.'); } catch (error) { notify(friendlyError(error.message), 'error'); } };
  document.querySelectorAll('[data-broadcast]').forEach(button => button.onclick = () => action(`/api/broadcast/${button.dataset.broadcast}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ winner: button.dataset.winner ? Number(button.dataset.winner) : null }) }, `${button.textContent} started.`, button));
  document.querySelectorAll('[data-timer-action]').forEach(button => button.onclick = () => action('/api/broadcast/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: button.dataset.timerAction }) }, 'Broadcast timer updated.', button));
  document.getElementById('refresh-preview').onclick = event => htmx.trigger(document.getElementById('obs-live-preview'), 'manualRefresh');
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
  function connectControlSocket() {
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    socket.onopen = () => {
      clearTimeout(socketReconnectTimer);
      document.getElementById('save-status').textContent = 'Connected';
    };
    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.state) { state = message.state; render(); }
        if (message.obs) renderObs(message.obs);
        if (message.replays) renderReplays(message.replays);
        if (message.replayOperation) renderReplayOperation(message.replayOperation);
      } catch (error) {
        console.error('Unable to process server update:', error);
        notify('A server update could not be rendered.', 'error');
      }
    };
    socket.onclose = () => {
      document.getElementById('save-status').textContent = 'Reconnecting…';
      clearTimeout(socketReconnectTimer);
      socketReconnectTimer = setTimeout(connectControlSocket, 1505);
    };
    socket.onerror = () => {
      document.getElementById('save-status').textContent = 'Connection error';
    };
  }
  connectControlSocket();
  Promise.all([fetch('/api/state').then(response => response.json()), fetch('/api/network').then(response => response.json())]).then(([data, network]) => { state = data.state; render(); renderObs(data.obs); renderReplays(data.replays); renderReplayOperation(data.state.replayOperation); document.getElementById('obs-address').value = state.obs.address; document.getElementById('obs-port').value = state.obs.port; document.getElementById('network-addresses').textContent = `LAN: ${(network.addresses || []).join(', ') || 'localhost'}:${network.port}`; refreshGuestProfiles(); loadObsCredentials(); }).catch(error => notify(friendlyError(error.message), 'error'));
  setInterval(updateTimerDisplay, 250);
}());
