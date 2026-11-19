# Tekken 8 OBS Tournament Overlay for Bahria University

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![OBS Studio](https://img.shields.io/badge/OBS%20Studio-28%2B-302E31.svg)](https://obsproject.com/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933.svg)](https://nodejs.org/)
[![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4.svg)](https://www.microsoft.com/windows)

**A tournament-ready Tekken 8 OBS overlay, scoreboard, broadcast controller, and instant replay system built for Bahria University Esports events.**

Run a live Tekken 8 tournament from a browser-based control panel, connect OBS Studio over WebSocket, display a transparent 1920x1080 overlay, control match presentation states, and publish 5-second or 10-second slow-motion replays with synchronized audio.

## Features

- Transparent OBS Browser Source overlay for 1920x1080 broadcasts
- Operator scoreboard for player names, characters, round, round time, game number, and set scores
- Match Intro, Game Transition, Winner, Tournament Standby, Gameplay, and Replay states
- Configurable server-controlled presentation timers
- OBS WebSocket v5 connection and live OBS status
- Genuine low-latency OBS Program WebRTC preview through the local control panel
- 5-second and 10-second slow-motion replay capture using FFmpeg
- LAN control panel access for an operator PC or another device
- Local tournament and replay management with no cloud account required

## Contents

- [System requirements](#system-requirements)
- [Quick start](#quick-start)
- [OBS setup](#obs-setup)
- [Using the control panel](#using-the-control-panel)
- [LAN and projector setup](#lan-and-projector-setup)
- [OBS troubleshooting](#obs-troubleshooting)
- [Data and privacy](#data-and-privacy)
- [License](#license)

## System requirements

- Windows 10 or 11
- Node.js 18 or newer
- OBS Studio 28 or newer (for OBS WebSocket v5)
- FFmpeg available on the Windows `PATH`
- An event projector or second display is recommended

## Quick start

1. Install Node.js and FFmpeg.
2. Double-click `start.bat`.
3. Wait for the browser to open at `http://localhost:3000/control`.
4. Open OBS and enable its WebSocket server.
5. Add the overlay browser source described below.
6. Connect OBS from the control panel's **System** section.

The first control-panel load asks for an operator token. When `OPERATOR_TOKEN` is not
configured, the server creates a local token in `data/operator-token` and prints it
to the server console. Set `OPERATOR_TOKEN` in the environment before starting the
server if you want to manage the token explicitly. The overlay remains read-only;
replay browser callbacks are accepted only for the currently active replay.

You can also start the system from PowerShell:

```powershell
npm install
npm start
```

The control panel is available at `http://localhost:3000/control`. The overlay is available at `http://localhost:3000/overlay`.

## OBS setup

### YouTube broadcast preview

Paste a public YouTube livestream URL into the control panel's Live Preview section, then click **Load**. The preview uses YouTube's official IFrame Player API and is not a separate OBS capture or local transcoder.

Supported link formats include `youtube.com/watch?v=VIDEO_ID`, `youtu.be/VIDEO_ID`, `youtube.com/live/VIDEO_ID`, and `youtube.com/embed/VIDEO_ID`. The video ID is saved locally and restored after a control-panel refresh.

### 1. Enable OBS WebSocket

1. In OBS, open **Tools > WebSocket Server Settings**.
2. Enable **Enable WebSocket server**.
3. Use port `4455` unless a different port is intentionally configured.
4. Enable authentication and set a password if required.
5. Enter the same address, port, and password in the control panel **System** section.

The server connects to OBS on the operator PC by default using `127.0.0.1:4455`. OBS credentials are stored in the backend tournament state and are not sent to browser clients.

### 2. Create the tournament overlay source

1. Create a scene such as `Tournament`.
2. Add a **Browser** source.
3. Set the URL to:

   `http://localhost:3000/overlay`

   For a separately configured OBS PC, replace `localhost` with the tournament server PC's LAN IP, for example `http://192.168.1.20:3000/overlay`.
4. Set width to `1920` and height to `1080`.
5. Enable both **Shutdown source when not visible** and **Refresh browser when scene becomes active** only if you understand that replay state may need to reload.
6. Leave **Control audio via OBS** disabled unless audio is intentionally required.
7. Use **Custom CSS** with `body { background: transparent; margin: 0; overflow: hidden; }` if the source needs an explicit transparent page style.
8. Apply the source and confirm that the overlay becomes visible.

Replay video is rendered inside this Browser Source. Do not add a separate OBS media source for replay files.

### 3. Configure canvas and output

1. Open **Settings > Video**.
2. Set Base (Canvas) Resolution to `1920x1080`.
3. Set Output (Scaled) Resolution to `1920x1080`.
4. Choose a common frame rate such as `60 FPS` or `30 FPS`.
5. Open **Settings > Advanced** and confirm a sensible process priority and rendering method for the PC.
6. Verify in OBS that the Tournament scene is selected under **Program**.

Resolution or aspect-ratio changes require matching Browser Source width and height changes.

### 4. Configure the replay buffer

1. Open **Settings > Output**.
2. Set Output Mode to **Advanced** if Replay Buffer options are not visible.
3. Open the **Replay Buffer** tab.
4. Set Maximum Replay Time to at least `15 seconds` for reliable 10-second captures.
5. Set a suitable local recording folder.
6. Click **Start Replay Buffer** in OBS.

The control panel should show the replay buffer as active after OBS connects. The server requires OBS WebSocket to confirm that the replay file was saved before processing it.

### 5. Configure FFmpeg

Test FFmpeg from PowerShell:

```powershell
ffmpeg -version
```

If the command is not recognized, install FFmpeg and add its `bin` folder to the Windows `PATH`, then reopen the terminal and OBS. The server does not create or overwrite the original OBS recording. It creates a separate 0.5x processed file in `data/processed-replays`.

## Using the control panel

### Match information

Update the tournament name, round, round time, game number, player names, characters, and notes in the control panel. Changes synchronize to connected overlay clients.

### Scores

Use the plus and minus buttons to adjust set scores. **Start next game** advances the game number and clears the presentation state. **Swap sides** swaps both player fields and scores. **Reset scores** resets both scores. **Clear match** returns the match fields to the ready state.

### Presentation states

Use **Broadcast** to switch the overlay to:

- Active Gameplay
- Match Intro
- Game Transition
- P1 Winner
- P2 Winner
- Tournament Standby
- Replay

Match Intro, Game Transition, and Winner presentation states can return automatically according to their timer settings. Replay automatically exits only after the Browser Source reports that video playback has ended or after playback is stopped.

Timer controls include skip, extend by five seconds, cancel, and return to gameplay. The intro defaults to 8 seconds, transition to 4 seconds, and winner to 10 seconds.

### Instant replay

1. Confirm OBS is connected and the Replay Buffer is running.
2. Select **5s SLOWDOWN REPLAY** or **10s SLOWDOWN REPLAY**.
3. Wait for OBS to save the replay and FFmpeg to finish processing.
4. The replay is loaded into the overlay Browser Source and played at 0.5x speed with synchronized audio.
5. Use **Stop playback** to return immediately to gameplay.

Original OBS replay buffer recordings are never overwritten. Processed files and replay metadata are stored locally; the replay library supports renaming and deleting entries from the control panel.

## LAN and projector setup

1. Connect the projector or television by HDMI.
2. In Windows display settings, select **Extend these displays**.
3. Open OBS and use **Fullscreen Projector (Program)** on the projector display.
4. Confirm the Tournament scene is active on the OBS Program preview.
5. Keep a private/local network for event operations.

To open the control panel from another PC or phone:

1. Find the host PC's IPv4 address with `ipconfig`.
2. Open `http://<host-ip>:3000/control` on the operator device.
3. The host server listens on TCP port `3000`.

If LAN access is blocked:

1. Open **Windows Defender Firewall > Allow an app through firewall**.
2. Allow Node.js on **Private** networks.
3. Alternatively, create an inbound firewall rule for TCP port `3000` scoped to the private network.

Do not expose port `3000` or OBS WebSocket to the public internet. The current application is designed for a trusted local event network.

## OBS troubleshooting

| Problem | Check |
|---|---|
| Overlay is blank | Confirm the server is running, Browser Source URL includes `/overlay`, and refresh the Browser Source |
| OBS is disconnected | Enable OBS WebSocket v5, confirm port `4455`, and enter the correct password |
| OBS preview unavailable | Confirm OBS is running and connected from the control panel |
| Replay buffer stopped | Click **Start Replay Buffer** in OBS or use the control panel **Start buffer** button |
| Replay save fails | Use a Replay Buffer length of at least 15 seconds and confirm OBS can write to the replay folder |
| FFmpeg replay fails | Run `ffmpeg -version`; add FFmpeg to `PATH` and restart the server |
| Port 3000 is blocked | Allow Node.js through Windows Defender Firewall on Private networks |

## Data and privacy

The server stores persistent state in:

- `data/tournament.json`
- `data/replays.json`
- `data/processed-replays/`
- `data/guest-media/`

Default runtime data is created automatically when the server first starts. Existing
guest photographs are migrated to `data/guest-media/` while retaining JSON backups.
Runtime replay and tournament state are excluded from Git, while the application
source is licensed under the MIT License.

## License

MIT License. See [LICENSE](LICENSE).
