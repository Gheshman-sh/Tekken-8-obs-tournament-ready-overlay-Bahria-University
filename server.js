const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const OBSWebSocket = require('obs-websocket-js').default;

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'tournament.json');
const REPLAYS_FILE = path.join(DATA_DIR, 'replays.json');
const GUEST_PROFILES_FILE = path.join(DATA_DIR, 'guest-profiles.json');
const OBS_CREDENTIALS_FILE = path.join(DATA_DIR, 'obs-credentials.json');
const PROCESSED_REPLAY_DIR = path.join(DATA_DIR, 'processed-replays');
const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT) || 3000;

const defaultState = {
  tournamentName: 'BAHRIA UNIVERSITY ESPORTS SHOWDOWN',
  roundName: 'Winners Final',
  roundTime: '60',
  gameNumber: 1,
  matchFormat: 'BEST OF 5',
  notes: '',
  player1: { name: 'Player 1', character: '', score: 0 },
  player2: { name: 'Player 2', character: '', score: 0 },
  broadcast: { mode: 'gameplay', winner: null, timer: null, previousMode: null },
  specialGuest: { name: '', title: '', organization: '', subtitle: '', photo: '' },
  transitionSettings: {
    preset: 'cinematic',
    duration: 700,
    easing: 'cubic-bezier(.22,.61,.36,1)',
    entrance: 'zoom-in',
    exit: 'fade'
  },
  transitionOverrides: {
    gameplay: null,
    match_intro: null,
    game_transition: null,
    winner: null,
    standby: null,
    special_guest: null
  },
  broadcastTimers: {
    match_intro: { enabled: true, duration: 8, nextMode: 'gameplay' },
    game_transition: { enabled: true, duration: 4, nextMode: 'gameplay' },
    winner: { enabled: true, duration: 10, nextMode: 'standby' }
  },
  settings: {
    showTournament: true,
    showCharacters: true,
    showPlayers: true,
    showRound: true,
    showReplayIndicator: true,
    animationsEnabled: true,
    autoReturn: true
  },
  obs: { address: '127.0.0.1', port: 4455, password: '' }
};

function ensureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROCESSED_REPLAY_DIR, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState, null, 2));
  if (!fs.existsSync(REPLAYS_FILE)) fs.writeFileSync(REPLAYS_FILE, '[]');
  if (!fs.existsSync(GUEST_PROFILES_FILE)) fs.writeFileSync(GUEST_PROFILES_FILE, '[]');
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    console.error(`Unable to read ${file}:`, error.message);
    return fallback;
  }
}
function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}
function mergeState(saved) {
  const sanitizedObs = { ...(saved.obs || {}) };
  delete sanitizedObs.password;
  return {
    ...defaultState, ...saved,
    player1: { ...defaultState.player1, ...(saved.player1 || {}) },
    player2: { ...defaultState.player2, ...(saved.player2 || {}) },
    settings: { ...defaultState.settings, ...(saved.settings || {}) },
    broadcast: { ...defaultState.broadcast, ...(saved.broadcast || {}) },
    specialGuest: { ...defaultState.specialGuest, ...(saved.specialGuest || {}) },
    transitionSettings: { ...defaultState.transitionSettings, ...(saved.transitionSettings || {}) },
    transitionOverrides: { ...defaultState.transitionOverrides, ...(saved.transitionOverrides || {}) },
    broadcastTimers: {
      ...defaultState.broadcastTimers,
      ...(saved.broadcastTimers || {}),
      match_intro: { ...defaultState.broadcastTimers.match_intro, ...((saved.broadcastTimers || {}).match_intro || {}) },
      game_transition: { ...defaultState.broadcastTimers.game_transition, ...((saved.broadcastTimers || {}).game_transition || {}) },
      winner: { ...defaultState.broadcastTimers.winner, ...((saved.broadcastTimers || {}).winner || {}) }
    },
    obs: { ...defaultState.obs, ...sanitizedObs }
  };
}
ensureData();
let state = mergeState(readJson(STATE_FILE, defaultState));
let replays = readJson(REPLAYS_FILE, []);
let guestProfiles = readJson(GUEST_PROFILES_FILE, []);
let replayActive = false;
let activeReplayId = null;
let replaySequence = 0;
let replayOperation = { status: 'idle', preset: null, message: '', busy: false };
let replaySaveWaiter;
let broadcastTimer;
const broadcastModes = new Set(['gameplay', 'match_intro', 'game_transition', 'winner', 'standby', 'special_guest', 'replay_intro', 'replay']);
const timerActions = new Set(['skip', 'extend', 'cancel', 'gameplay', 'previous']);
function publicReplays() {
  return replays.map(replay => ({ ...replay, available: Boolean(replay.filePath && fs.existsSync(path.resolve(replay.filePath))) }));
}

const OBS_CREDENTIAL_KEY_FILE = path.join(DATA_DIR, '.obs-credentials.key');

function credentialKey() {
  if (!fs.existsSync(OBS_CREDENTIAL_KEY_FILE)) {
    fs.writeFileSync(OBS_CREDENTIAL_KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  }
  const key = fs.readFileSync(OBS_CREDENTIAL_KEY_FILE);
  return key.length === 32 ? key : crypto.createHash('sha256').update(key).digest();
}

function encryptCredential(value) {
  if (!value) return '';
  const key = credentialKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString('base64'),
    content: encrypted.toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  });
}

function decryptCredential(value) {
  if (!value) return '';
  try {
    const payload = JSON.parse(value);
    const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(), Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload.content, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    return '';
  }
}

function readObsCredentials() {
  const saved = readJson(OBS_CREDENTIALS_FILE, {});
  return {
    remember: Boolean(saved.remember),
    address: saved.address || state.obs.address || '127.0.0.1',
    port: Number(saved.port) || state.obs.port || 4455,
    password: saved.remember && saved.passwordEncrypted ? decryptCredential(saved.passwordEncrypted) : ''
  };
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();
const obs = new OBSWebSocket();
const obsStatus = { connected: false, replayBufferActive: false, recording: false, streaming: false, error: '' };

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.get('/vendor/htmx.min.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', 'htmx.org', 'dist', 'htmx.min.js')));
app.get('/', (req, res) => res.redirect('/control'));
app.get('/control', (req, res) => res.sendFile(path.join(ROOT, 'public', 'control.html')));
app.get('/overlay', (req, res) => res.sendFile(path.join(ROOT, 'public', 'overlay.html')));
app.get('/api/state', (req, res) => res.json({ state: publicState(), obs: obsStatus, replays: publicReplays() }));
app.get('/api/network', (req, res) => res.json({ port: PORT, addresses: localAddresses() }));
app.get('/api/replays', (req, res) => res.json(publicReplays()));
app.get('/api/guest-profiles', (req, res) => res.json({ profiles: guestProfiles }));
app.post('/api/guest-profiles', (req, res) => {
  const profile = req.body && req.body.profile;
  if (!profile || !String(profile.name || '').trim()) return res.status(400).json({ error: 'A guest name is required.' });
  const id = profile.id || `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const saved = {
    id,
    name: String(profile.name || '').trim(),
    title: String(profile.title || '').trim(),
    organization: String(profile.organization || '').trim(),
    subtitle: String(profile.subtitle || '').trim(),
    photo: typeof profile.photo === 'string' ? profile.photo : ''
  };
  const index = guestProfiles.findIndex(item => item.id === id);
  if (index >= 0) guestProfiles[index] = saved;
  else guestProfiles.push(saved);
  writeJson(GUEST_PROFILES_FILE, guestProfiles);
  res.json({ profiles: guestProfiles });
});
app.delete('/api/guest-profiles/:id', (req, res) => {
  guestProfiles = guestProfiles.filter(profile => profile.id !== req.params.id);
  writeJson(GUEST_PROFILES_FILE, guestProfiles);
  res.json({ profiles: guestProfiles });
});
app.get('/api/obs/credentials', (req, res) => {
  const credentials = readObsCredentials();
  res.json({ remember: credentials.remember, address: credentials.address, port: credentials.port });
});
app.put('/api/obs/credentials', (req, res) => {
  const remember = Boolean(req.body && req.body.remember);
  const address = String(req.body && req.body.address || '').trim();
  const port = Number(req.body && req.body.port);
  const password = String(req.body && req.body.password || '');
  if (address && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return res.status(400).json({ error: 'Enter a valid OBS port.' });
  }
  if (!remember) {
    writeJson(OBS_CREDENTIALS_FILE, { remember: false, address: '', port: 4455, passwordEncrypted: '' });
  } else {
    const existing = readJson(OBS_CREDENTIALS_FILE, {});
    writeJson(OBS_CREDENTIALS_FILE, {
      remember: true,
      address: address || existing.address || '127.0.0.1',
      port: port || existing.port || 4455,
      passwordEncrypted: password ? encryptCredential(password) : (existing.passwordEncrypted || '')
    });
  }
  res.json({ remember, address: address || '127.0.0.1', port: port || 4455 });
});
app.get('/api/replays/:id/video', (req, res) => {
  const replay = replays.find(item => item.id === req.params.id);
  if (!replay || !replay.filePath) return res.status(404).json({ error: 'Replay not found.' });
  const filePath = path.resolve(replay.filePath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Replay file is unavailable.' });
  res.sendFile(filePath, { dotfiles: 'deny' }, error => {
    if (error && !res.headersSent) res.status(error.statusCode || 500).json({ error: 'Replay file could not be served.' });
  });
});
app.get('/api/obs/preview', async (req, res) => {
  if (!obsStatus.connected) return res.status(503).json({ error: 'OBS is not connected.' });
  try {
    const scene = await obsRequest('GetCurrentProgramScene');
    const screenshot = await obsRequest('GetSourceScreenshot', {
      sourceName: scene.currentProgramSceneName,
      imageFormat: 'png',
      imageWidth: 1920,
      imageHeight: 1080,
      imageCompressionQuality: 100
    });
    res.json({ imageData: screenshot.imageData, sceneName: scene.currentProgramSceneName });
  } catch (error) {
    res.status(502).json({ error: `OBS preview failed: ${error.message}` });
  }
});
app.get('/api/obs/preview/htmx', async (req, res) => {
  if (!obsStatus.connected) {
    res.set('X-OBS-Preview', 'disconnected');
    return res.send('<iframe class="preview-fallback" src="/overlay?preview=1" title="Transparent tournament overlay preview"></iframe>');
  }
  try {
    const scene = await obsRequest('GetCurrentProgramScene');
    const screenshot = await obsRequest('GetSourceScreenshot', {
      sourceName: scene.currentProgramSceneName,
      imageFormat: 'png',
      imageWidth: 1920,
      imageHeight: 1080,
      imageCompressionQuality: 100
    });
    res.set('X-OBS-Scene', scene.currentProgramSceneName);
    res.send(`<img class="htmx-preview-image" alt="OBS Program preview" src="${screenshot.imageData}">`);
  } catch (error) {
    res.set('X-OBS-Preview', 'error');
    return res.send('<iframe class="preview-fallback" src="/overlay?preview=1" title="Transparent tournament overlay preview"></iframe>');
  }
});

function publicState() {
  const broadcast = { ...state.broadcast };
  if (broadcast.timer) broadcast.timer = { ...broadcast.timer, remainingMs: Math.max(0, broadcast.timer.endsAt - Date.now()) };
  const activeReplay = activeReplayId ? { id: activeReplayId, url: `/api/replays/${encodeURIComponent(activeReplayId)}/video` } : null;
  return { ...state, broadcast, connectedClients: clients.size, obs: { address: state.obs.address, port: state.obs.port }, replayActive, activeReplay, replayOperation };
}
function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of clients) if (client.readyState === 1) client.send(payload);
}
function persistAndBroadcast() {
  writeJson(STATE_FILE, state);
  broadcast({ type: 'state', state: publicState(), obs: obsStatus, replays: publicReplays() });
}
function setBroadcastMode(mode, winner = null, duration = 0, nextMode = 'gameplay', enabled = true) {
  if (!broadcastModes.has(mode)) throw new Error('Unknown broadcast mode.');
  clearTimeout(broadcastTimer);
  const currentBroadcast = state.broadcast || {};
  let previousMode = currentBroadcast.previousMode || null;
  if (mode === 'special_guest' && currentBroadcast.mode !== 'special_guest') {
    previousMode = currentBroadcast.mode || 'gameplay';
  } else if (mode === 'standby' && currentBroadcast.mode === 'special_guest') {
    previousMode = previousMode || 'gameplay';
  } else if (mode !== 'special_guest') {
    previousMode = mode === 'gameplay' ? null : previousMode;
  }
  const safeWinner = winner === 2 ? 2 : winner === 1 ? 1 : null;
  const safeDuration = Math.max(0, Number(duration) || 0);
  const timer = safeDuration > 0 && enabled && state.settings.autoReturn !== false ? {
    enabled: true,
    duration: safeDuration,
    nextMode: broadcastModes.has(nextMode) ? nextMode : 'gameplay',
    startedAt: Date.now(),
    endsAt: Date.now() + safeDuration * 1000
  } : null;
  state.broadcast = { mode, winner: safeWinner, timer, previousMode };
  persistAndBroadcast();
  if (timer) scheduleBroadcastTimer();
}
function scheduleBroadcastTimer() {
  clearTimeout(broadcastTimer);
  if (!state.broadcast.timer) return;
  const delay = Math.max(0, state.broadcast.timer.endsAt - Date.now());
  broadcastTimer = setTimeout(() => {
    const nextMode = state.broadcast.timer && state.broadcast.timer.nextMode || 'gameplay';
    setBroadcastMode(nextMode);
  }, delay);
}
function restoreBroadcastTimer() {
  if (!state.broadcast.timer) return;
  if (state.broadcast.timer.endsAt <= Date.now()) {
    setBroadcastMode(state.broadcast.timer.nextMode || 'gameplay');
  } else scheduleBroadcastTimer();
}
restoreBroadcastTimer();
function localAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) if (item.family === 'IPv4' && !item.internal) addresses.push(item.address);
  }
  return addresses;
}
function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(99, Math.round(number))) : fallback;
}
function setReplayOperation(status, message = '', preset = replayOperation.preset, busy = ['saving', 'processing', 'replay_intro', 'loading', 'playing'].includes(status)) {
  replayOperation = { status, preset, message, busy };
  broadcast({ type: 'replayStatus', replayOperation });
}
function waitForReplaySaved(timeoutMs = 15000) {
  if (replaySaveWaiter) throw new Error('Another replay save is already in progress.');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      replaySaveWaiter = null;
      reject(new Error('OBS did not confirm the replay file was saved.'));
    }, timeoutMs);
    replaySaveWaiter = {
      resolve: filePath => {
        clearTimeout(timeout);
        replaySaveWaiter = null;
        resolve(filePath);
      },
      reject: error => {
        clearTimeout(timeout);
        replaySaveWaiter = null;
        reject(error);
      }
    };
  });
}
async function saveReplayBufferConfirmed() {
  const savedConfirmation = waitForReplaySaved();
  try {
    await obsRequest('SaveReplayBuffer');
    return await savedConfirmation;
  } catch (error) {
    if (replaySaveWaiter) replaySaveWaiter.reject(error);
    throw error;
  }
}
async function processSlowMotion(sourcePath, seconds) {
  const resolvedSource = path.resolve(sourcePath);
  const outputName = `slowmo-${seconds}s-${Date.now()}-${path.basename(resolvedSource, path.extname(resolvedSource))}.mp4`;
  const outputPath = path.join(PROCESSED_REPLAY_DIR, outputName);
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-sseof', `-${seconds}`, '-i', resolvedSource,
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', 'setpts=2*PTS', '-af', 'atempo=0.5',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      outputPath
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    return outputPath;
  } catch (error) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (cleanupError) { console.error('Replay cleanup failed:', cleanupError.message); }
    throw new Error(`FFmpeg slow-motion processing failed: ${error.stderr || error.message}`.trim());
  }
}

app.put('/api/state', (req, res) => {
  const incoming = req.body || {};
  state = mergeState({
    ...state,
    ...incoming,
    player1: { ...state.player1, ...(incoming.player1 || {}) },
    player2: { ...state.player2, ...(incoming.player2 || {}) },
    settings: { ...state.settings, ...(incoming.settings || {}) },
    broadcast: state.broadcast,
    broadcastTimers: incoming.broadcastTimers || state.broadcastTimers,
    obs: state.obs
  });
  state.player1.score = safeNumber(state.player1.score);
  state.player2.score = safeNumber(state.player2.score);
  persistAndBroadcast();
  res.json({ state: publicState() });
});
app.post('/api/broadcast/:mode(gameplay|match_intro|game_transition|winner|standby|special_guest|replay)', (req, res) => {
  const mode = req.params.mode;
  const winner = Number(req.body && req.body.winner);
  const configured = state.broadcastTimers[mode];
  const duration = req.body && req.body.duration != null ? Number(req.body.duration) : configured && configured.duration;
  const enabled = req.body && req.body.enabled != null ? Boolean(req.body.enabled) : configured && configured.enabled;
  const nextMode = req.body && req.body.nextMode || configured && configured.nextMode || 'gameplay';
  try {
    setBroadcastMode(mode, winner, duration, nextMode, enabled);
    res.json({ state: publicState() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.post('/api/broadcast/action', (req, res) => {
  const action = req.body && req.body.action;
  if (!timerActions.has(action)) return res.status(400).json({ error: 'Unknown broadcast timer action.' });
  if (action === 'gameplay') {
    setBroadcastMode('gameplay');
  } else if (action === 'previous') {
    setBroadcastMode(state.broadcast.previousMode && broadcastModes.has(state.broadcast.previousMode)
      ? state.broadcast.previousMode
      : 'gameplay');
  } else if (action === 'skip') {
    setBroadcastMode(state.broadcast.timer ? state.broadcast.timer.nextMode : 'gameplay');
  } else if (action === 'cancel') {
    if (!state.broadcast.timer) return res.status(400).json({ error: 'No active presentation timer.' });
    clearTimeout(broadcastTimer);
    state.broadcast.timer = null;
    persistAndBroadcast();
  } else if (action === 'extend') {
    if (!state.broadcast.timer) return res.status(400).json({ error: 'No active presentation timer.' });
    state.broadcast.timer.endsAt += 5000;
    persistAndBroadcast();
    scheduleBroadcastTimer();
  }
  res.json({ state: publicState() });
});

app.post('/api/broadcast/preview', (req, res) => {
  broadcast({
    type: 'transitionPreview',
    preset: String(req.body && req.body.preset || 'cinematic'),
    duration: Number(req.body && req.body.duration || state.transitionSettings.duration || 700),
    easing: String(req.body && req.body.easing || state.transitionSettings.easing || 'cubic-bezier(.22,.61,.36,1)')
  });
  res.json({ ok: true });
});

app.post('/api/obs/connect', async (req, res) => {
  const remembered = readObsCredentials();
  const address = String(req.body.address || remembered.address || state.obs.address).trim();
  const port = Number(req.body.port || remembered.port || state.obs.port);
  const password = String(req.body.password || remembered.password || '');
  if (!address || !Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: 'Enter a valid OBS address and port.' });
  state.obs = { address, port };
  try {
    if (obsStatus.connected) await obs.disconnect();
    await obs.connect(`ws://${address}:${port}`, password);
    obsStatus.connected = true;
    obsStatus.error = '';
    await refreshObsStatus();
    writeJson(STATE_FILE, state);
    broadcast({ type: 'obs', obs: obsStatus });
    res.json({ obs: obsStatus });
  } catch (error) {
    obsStatus.connected = false;
    obsStatus.error = error.message;
    broadcast({ type: 'obs', obs: obsStatus });
    res.status(502).json({ error: `OBS connection failed: ${error.message}` });
  }
});
app.post('/api/obs/disconnect', async (req, res) => {
  try { if (obsStatus.connected) await obs.disconnect(); } catch (error) { console.error('OBS disconnect failed:', error.message); }
  obsStatus.connected = false;
  broadcast({ type: 'obs', obs: obsStatus });
  res.json({ obs: obsStatus });
});

async function obsRequest(requestType, requestData) {
  if (!obsStatus.connected) throw new Error('OBS is not connected.');
  return obs.call(requestType, requestData);
}
async function refreshObsStatus() {
  const errors = [];
  try {
    const status = await obsRequest('GetReplayBufferStatus');
    obsStatus.replayBufferActive = Boolean(status.outputActive);
  } catch (error) {
    obsStatus.replayBufferActive = false;
    errors.push(`Replay buffer: ${error.message}`);
  }
  try {
    const stream = await obsRequest('GetStreamStatus');
    obsStatus.streaming = Boolean(stream.outputActive);
    obsStatus.recording = Boolean(stream.outputReconnecting);
  } catch (error) {
    obsStatus.streaming = false;
    obsStatus.recording = false;
    errors.push(`Stream status: ${error.message}`);
  }
  try {
    obsStatus.recording = obsStatus.recording || Boolean((await obsRequest('GetRecordStatus')).outputActive);
  } catch (error) {
    errors.push(`Recording status: ${error.message}`);
  }
  obsStatus.error = errors.join(' ');
}
async function runObsAction(action) {
  try {
    await action();
    await refreshObsStatus();
    obsStatus.error = '';
    broadcast({ type: 'obs', obs: obsStatus });
    return true;
  } catch (error) {
    console.error('OBS action failed:', error);
    obsStatus.error = error.message;
    broadcast({ type: 'obs', obs: obsStatus });
    return false;
  }
}
app.post('/api/replay/preset', async (req, res) => {
  const seconds = Number(req.body && req.body.seconds);
  if (![5, 10].includes(seconds)) return res.status(400).json({ error: 'Replay preset must be 5 or 10 seconds.' });
  if (replayOperation.busy) return res.status(409).json({ error: 'A replay operation is already in progress.' });
  if (!obsStatus.connected) return res.status(502).json({ error: 'OBS is not connected.' });
  try {
    await refreshObsStatus();
    if (!obsStatus.replayBufferActive) throw new Error('OBS Replay Buffer is not running.');
    setReplayOperation('saving', `Saving the last ${seconds} seconds…`, seconds);
    const sourcePath = await saveReplayBufferConfirmed();
    setReplayOperation('processing', `Creating ${seconds}s 0.5× slow-motion replay…`, seconds);
    const processedPath = await processSlowMotion(sourcePath, seconds);
    const replay = addReplay(processedPath, { sourcePath, presetSeconds: seconds, slowMotion: 0.5 });
    await playReplay(replay.id);
    res.json({ obs: obsStatus, replays: publicReplays(), replayOperation });
  } catch (error) {
    console.error('Replay preset failed:', error);
    replaySaveWaiter = null;
    if (state.broadcast.mode === 'replay_intro') setBroadcastMode('gameplay');
    setReplayOperation('error', error.message, seconds, false);
    res.status(502).json({ error: error.message, replayOperation });
  }
});
app.post('/api/replay/:action', async (req, res) => {
  const action = req.params.action;
  let result;
  if (action === 'start') result = await runObsAction(() => obsRequest('StartReplayBuffer'));
  else if (action === 'stop') result = await runObsAction(() => obsRequest('StopReplayBuffer'));
  else if (action === 'save') result = await runObsAction(async () => {
    addReplay(await saveReplayBufferConfirmed());
  });
  else if (action === 'play') {
    if (replayOperation.busy) return res.status(409).json({ error: 'A replay sequence is already in progress.' });
    result = await runObsAction(() => playReplay(req.body && req.body.id));
  }
  else if (action === 'stop-playback') result = await runObsAction(() => stopReplay());
  else return res.status(400).json({ error: 'Unknown replay action.' });
  if (!result) return res.status(502).json({ error: obsStatus.error || 'OBS action failed.' });
  res.json({ obs: obsStatus, replays: publicReplays() });
});
function addReplay(filePath, metadata = {}) {
  const item = { id: `${Date.now()}`, filePath, filename: path.basename(filePath), createdAt: new Date().toISOString(), player1: state.player1.name, player2: state.player2.name, roundName: state.roundName, ...metadata };
  replays.unshift(item);
  writeJson(REPLAYS_FILE, replays);
  broadcast({ type: 'replays', replays: publicReplays() });
  return item;
}
async function playReplay(id) {
  const replay = replays.find(item => item.id === id);
  if (!replay) throw new Error('Replay not found.');
  const sequence = ++replaySequence;
  replayActive = false;
  activeReplayId = null;
  broadcast({ type: 'replay', active: false });
  setBroadcastMode('replay_intro');
  setReplayOperation('replay_intro', 'Replay intro presentation active.', replayOperation.preset, true);
  await new Promise(resolve => setTimeout(resolve, 3000));
  if (sequence !== replaySequence) return;
  replayActive = true;
  activeReplayId = replay.id;
  setBroadcastMode('replay');
  setReplayOperation('loading', 'Loading replay in the OBS Browser Source.', replayOperation.preset);
  broadcast({ type: 'replay', active: true, replay: { id: replay.id, url: `/api/replays/${encodeURIComponent(replay.id)}/video` } });
}
async function stopReplay() {
  replaySequence += 1;
  replayActive = false;
  activeReplayId = null;
  setBroadcastMode('gameplay');
  setReplayOperation('finished', 'Replay playback stopped.', null, false);
  broadcast({ type: 'replay', active: false });
}
app.post('/api/replay/browser-status', (req, res) => {
  const status = String(req.body && req.body.status || '');
  const messages = {
    loading: 'Loading replay in the OBS Browser Source.',
    playing: 'Replay playback active.',
    error: String(req.body && req.body.message || 'Replay playback failed.')
  };
  if (!['loading', 'playing', 'error'].includes(status)) return res.status(400).json({ error: 'Invalid replay browser status.' });
  if (status === 'error') {
    replayActive = false;
    activeReplayId = null;
    setBroadcastMode('gameplay');
    setReplayOperation('error', messages.error, replayOperation.preset, false);
    broadcast({ type: 'replay', active: false });
  } else {
    setReplayOperation(status, messages[status], replayOperation.preset, status === 'playing');
  }
  res.json({ replayOperation });
});
app.post('/api/replay/browser-ended', (req, res) => {
  replayActive = false;
  activeReplayId = null;
  setBroadcastMode('gameplay');
  setReplayOperation('finished', 'Replay playback finished.', null, false);
  broadcast({ type: 'replay', active: false });
  res.json({ replayOperation });
});
app.patch('/api/replays/:id', (req, res) => {
  const replay = replays.find(item => item.id === req.params.id);
  if (!replay) return res.status(404).json({ error: 'Replay not found.' });
  replay.filename = String(req.body.filename || replay.filename).trim() || replay.filename;
  writeJson(REPLAYS_FILE, replays);
  broadcast({ type: 'replays', replays: publicReplays() });
  res.json(replay);
});
app.delete('/api/replays/:id', (req, res) => {
  const index = replays.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Replay not found.' });
  replays.splice(index, 1);
  writeJson(REPLAYS_FILE, replays);
  broadcast({ type: 'replays', replays: publicReplays() });
  res.sendStatus(204);
});

obs.on('ConnectionClosed', () => { obsStatus.connected = false; broadcast({ type: 'obs', obs: obsStatus }); });
obs.on('ReplayBufferSaved', event => {
  if (!event.savedReplayPath) return;
  if (replaySaveWaiter) replaySaveWaiter.resolve(event.savedReplayPath);
});
wss.on('connection', socket => {
  clients.add(socket);
  socket.send(JSON.stringify({ type: 'snapshot', state: publicState(), obs: obsStatus, replays: publicReplays() }));
  broadcast({ type: 'state', state: publicState(), obs: obsStatus, replays: publicReplays() });
  socket.on('close', () => clients.delete(socket));
  socket.on('close', () => broadcast({ type: 'state', state: publicState(), obs: obsStatus, replays: publicReplays() }));
});

server.listen(PORT, '0.0.0.0', () => console.log(`Tekken Tournament running on http://localhost:${PORT}`));
