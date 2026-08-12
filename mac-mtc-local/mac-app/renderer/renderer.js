// Renderer: captures the audio input via getUserMedia (this is what triggers
// the macOS mic prompt and lists devices), decodes LTC in-process with the
// pure-JS decoder, and streams decoded frames to main for MTC + dashboard.

const $ = (id) => document.getElementById(id);

let running = false;
let audioCtx = null, streamNode = null, procNode = null, muteNode = null, stream = null;
let decoder = null;
let gain = 1.0;
let ltcChannel = 0;

function fillSelect(el, items, valueKey, labelFn, current) {
    el.innerHTML = '';
    for (const it of items) {
        const opt = document.createElement('option');
        opt.value = valueKey ? it[valueKey] : it;
        opt.textContent = labelFn ? labelFn(it) : it;
        el.appendChild(opt);
    }
    if (current !== undefined && current !== null) el.value = current;
}
function currentSettings() {
    return {
        audioDeviceId: $('audioInput').value || '',
        channels: parseInt($('channels').value || '2', 10),
        ltcChannel: parseInt($('ltcChannel').value || '0', 10),
        fps: $('fps').value,
        midiOut: $('midiOut').value || 'IAC Driver',
        gain: parseFloat($('gain').value || '1'),
        dashPort: parseInt($('dashPort').value || '8085', 10),
    };
}
function showBanner(msg, info) {
    const b = $('banner');
    if (!msg) { b.className = 'banner'; b.textContent = ''; return; }
    b.textContent = msg;
    b.className = 'banner show' + (info ? ' info' : '');
}

// ---- Audio device list (labels appear only after permission is granted) ----
async function refreshAudioInputs(selectId) {
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch (_) {}
    const inputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId);
    if (inputs.length === 0) {
        fillSelect($('audioInput'), [{ deviceId: '', label: 'Grant mic access (press Start)' }],
            'deviceId', (d) => d.label, '');
        return false;
    }
    fillSelect($('audioInput'), inputs, 'deviceId',
        (d) => d.label || `Input ${d.deviceId.slice(0, 6)}`, selectId);
    return true;
}

// ---- Start / stop capture --------------------------------------------------
async function startCapture(settings) {
    // getUserMedia triggers the macOS microphone prompt. Turn OFF all DSP or it
    // will destroy the LTC waveform.
    const constraints = {
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: { ideal: settings.channels },
            sampleRate: { ideal: 48000 },
        },
        video: false,
    };
    if (settings.audioDeviceId) constraints.audio.deviceId = { exact: settings.audioDeviceId };

    stream = await navigator.mediaDevices.getUserMedia(constraints);

    // Now that permission is granted, device labels are available — repopulate.
    const gotId = (stream.getAudioTracks()[0].getSettings().deviceId) || settings.audioDeviceId || '';
    await refreshAudioInputs(gotId);

    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    streamNode = audioCtx.createMediaStreamSource(stream);

    const chCount = Math.max(1, streamNode.channelCount || settings.channels);
    ltcChannel = Math.min(settings.ltcChannel, chCount - 1);
    gain = settings.gain;

    decoder = new window.LtcDecoder(48000, (frame) => {
        const h = frame.hours, m = frame.minutes, s = frame.seconds, f = frame.frames;
        // Local live display
        $('tc').textContent = `${p2(h)}:${p2(m)}:${p2(s)}:${p2(f)}`;
        $('tc').classList.add('live');
        $('lockdot').className = 'dot on';
        $('lockstate').textContent = 'Locked';
        lastFrameAt = performance.now();
        // Forward to main for MTC output + dashboard
        window.api.sendFrame({ h, m, s, f, drop: frame.drop, fps: frame.fps });
    });
    decoder.setGain(gain);

    // ScriptProcessor: simple and reliable for pulling raw PCM. Muted so the
    // LTC screech never reaches the speakers.
    procNode = audioCtx.createScriptProcessor(2048, chCount, 1);
    procNode.onaudioprocess = (e) => {
        const buf = e.inputBuffer;
        const ch = Math.min(ltcChannel, buf.numberOfChannels - 1);
        const data = buf.getChannelData(ch);          // Float32 [-1,1]
        const i16 = new Int16Array(data.length);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
            let s = data[i];
            const a = s < 0 ? -s : s;
            if (a > peak) peak = a;
            s *= 1; // gain applied inside decoder
            i16[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
        }
        decoder.process(i16);
        $('level').style.width = Math.min(100, Math.round(peak * gain * 140)) + '%';
    };

    muteNode = audioCtx.createGain();
    muteNode.gain.value = 0;
    streamNode.connect(procNode);
    procNode.connect(muteNode);
    muteNode.connect(audioCtx.destination);
    if (audioCtx.state === 'suspended') await audioCtx.resume();
}

function stopCapture() {
    try { if (procNode) procNode.disconnect(); } catch (_) {}
    try { if (muteNode) muteNode.disconnect(); } catch (_) {}
    try { if (streamNode) streamNode.disconnect(); } catch (_) {}
    try { if (audioCtx) audioCtx.close(); } catch (_) {}
    try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    procNode = muteNode = streamNode = audioCtx = stream = decoder = null;
}

// ---- Lock watchdog: drop the "Locked" indicator if frames stop -------------
let lastFrameAt = 0;
setInterval(() => {
    if (!running) return;
    if (performance.now() - lastFrameAt > 250) {
        $('lockdot').className = 'dot wait';
        $('lockstate').textContent = 'No signal';
        $('tc').classList.remove('live');
    }
}, 200);

function setRunningUI(on) {
    running = on;
    const btn = $('toggle');
    btn.textContent = on ? 'Stop' : 'Start';
    btn.className = 'btn' + (on ? ' stop' : '');
    for (const id of ['audioInput', 'channels', 'ltcChannel', 'fps', 'midiOut']) $(id).disabled = on;
    if (!on) {
        $('lockdot').className = 'dot';
        $('lockstate').textContent = 'Stopped';
        $('tc').classList.remove('live');
        $('level').style.width = '0%';
    }
}

function p2(n) { return String(n).padStart(2, '0'); }

// ---- Status from main (MIDI name, viewer count, dashboard URL, errors) -----
window.api.onStatus((st) => {
    if (st.midiName) $('midiname').textContent = st.midiName;
    if (st.rateLabel && running) $('fpsDisp').textContent = st.rateLabel;
    if ('clients' in st) $('clients').textContent = st.clients + (st.clients === 1 ? ' viewer' : ' viewers');
    if (st.dashUrls) $('lanurl').value = st.dashUrls.lan || st.dashUrls.local || 'unavailable';
    if (st.error) showBanner(st.error);
});

// ---- Controls --------------------------------------------------------------
$('toggle').addEventListener('click', async () => {
    if (running) {
        stopCapture();
        await window.api.engineStop();
        setRunningUI(false);
        showBanner('');
        return;
    }
    showBanner('');
    const settings = currentSettings();

    // Ask macOS for microphone access first (main process → OS prompt). On a
    // packaged app this is what actually makes the system prompt appear.
    try {
        const mic = await window.api.requestMic();
        if (!mic || !mic.ok) {
            showBanner('Microphone access is needed. If macOS didn\u2019t ask, enable it in System Settings \u2192 Privacy & Security \u2192 Microphone (look for "LTC to MTC"), then press Start again.');
            return;
        }
    } catch (_) { /* fall through and let getUserMedia try anyway */ }

    try {
        await startCapture(settings);           // starts decode (also prompts if needed)
    } catch (err) {
        stopCapture();
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
            showBanner('Microphone access was denied. Enable it in System Settings → Privacy & Security → Microphone (look for "LTC to MTC", or "Electron" in dev), then try Start again.');
        } else if (err && err.name === 'NotFoundError') {
            showBanner('No audio input found. Connect your USB interface and press ↻ Rescan.');
        } else {
            showBanner('Could not start audio: ' + (err && err.message ? err.message : String(err)));
        }
        return;
    }
    const res = await window.api.engineStart(settings);   // opens MIDI, starts sender
    if (res && res.midiName) $('midiname').textContent = res.midiName;
    if (res && res.virtual) showBanner('No matching MIDI port — created a virtual "LTC to MTC" port. Point your MTC device at it, or enable an IAC bus.', true);
    setRunningUI(true);
});

$('refresh').addEventListener('click', async () => {
    await refreshAudioInputs($('audioInput').value);
    const d = await window.api.refreshMidi();
    const s = currentSettings();
    const midiItems = d.midiOutputs.slice();
    if (!midiItems.includes(s.midiOut)) midiItems.unshift(s.midiOut);
    if (!midiItems.some((n) => /IAC/i.test(n))) midiItems.push('IAC Driver');
    fillSelect($('midiOut'), midiItems, null, null, s.midiOut);
});
$('gain').addEventListener('input', () => {
    gain = parseFloat($('gain').value);
    $('gainval').textContent = gain.toFixed(1) + '×';
    if (decoder) decoder.setGain(gain);            // live while running
});
$('ltcChannel').addEventListener('change', () => { ltcChannel = parseInt($('ltcChannel').value || '0', 10); });
$('opendash').addEventListener('click', () => window.api.openDashboard());
$('copyurl').addEventListener('click', () => {
    const u = $('lanurl').value;
    if (u && u !== 'unavailable' && u !== 'starting…') {
        navigator.clipboard.writeText(u);
        $('copyurl').textContent = 'Copied!';
        setTimeout(() => ($('copyurl').textContent = 'Copy LAN link'), 1200);
    }
});
$('dashPort').addEventListener('change', () => {
    window.api.setDashPort(parseInt($('dashPort').value || '8085', 10));
    window.api.saveSettings(currentSettings());
});
for (const id of ['audioInput', 'channels', 'ltcChannel', 'fps', 'midiOut', 'gain']) {
    $(id).addEventListener('change', () => window.api.saveSettings(currentSettings()));
}
navigator.mediaDevices && navigator.mediaDevices.addEventListener &&
    navigator.mediaDevices.addEventListener('devicechange', () => refreshAudioInputs($('audioInput').value));

// ---- Init ------------------------------------------------------------------
(async () => {
    const init = await window.api.getInit();
    const s = init.settings;

    await refreshAudioInputs(s.audioDeviceId);

    const midiItems = init.midiOutputs.slice();
    if (!midiItems.includes(s.midiOut)) midiItems.unshift(s.midiOut);
    if (!midiItems.some((n) => /IAC/i.test(n))) midiItems.push('IAC Driver');
    fillSelect($('midiOut'), midiItems, null, null, s.midiOut);

    $('channels').value = s.channels;
    $('ltcChannel').value = s.ltcChannel;
    $('fps').value = s.fps;
    $('gain').value = s.gain;
    $('gainval').textContent = (+s.gain).toFixed(1) + '×';
    $('dashPort').value = s.dashPort || 8085;
    if (init.dashUrls && (init.dashUrls.lan || init.dashUrls.local)) {
        $('lanurl').value = init.dashUrls.lan || init.dashUrls.local;
    }

    if (!init.midiAvailable) showBanner('MIDI module not available — MTC output disabled (dashboard still works). Rebuild the app.');
    else if (!init.dashAvailable) showBanner('WebSocket module (ws) not installed — LAN dashboard disabled.', true);
})();
