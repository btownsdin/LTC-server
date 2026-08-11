const $ = (id) => document.getElementById(id);
let running = false;

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
        audioInput: $('audioInput').value || '0',
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

async function populate(init) {
    const s = init.settings;

    // Audio inputs
    if (init.audioInputs.length) {
        fillSelect($('audioInput'), init.audioInputs, 'index',
            (d) => `[${d.index}] ${d.name}`, s.audioInput);
    } else {
        fillSelect($('audioInput'), [{ index: s.audioInput, name: 'Default input' }], 'index',
            (d) => `[${d.index}] ${d.name}`, s.audioInput);
    }

    // MIDI outputs — include the saved name and a virtual-port option
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
    else if (!init.ffmpegAvailable) showBanner('Bundled ffmpeg not found — audio capture disabled.');
    else if (!init.dashAvailable) showBanner('WebSocket module (ws) not installed — LAN dashboard disabled.', true);
}

function setRunningUI(on) {
    running = on;
    const btn = $('toggle');
    btn.textContent = on ? 'Stop' : 'Start';
    btn.className = 'btn' + (on ? ' stop' : '');
    for (const id of ['audioInput', 'channels', 'ltcChannel', 'fps', 'midiOut']) $(id).disabled = on;
}

// ---- Live status from main ----
window.api.onStatus((st) => {
    if ('running' in st) setRunningUI(st.running);
    if (st.tc) $('tc').textContent = st.tc;

    if ('locked' in st) {
        const dot = $('lockdot'), label = $('lockstate'), tc = $('tc');
        if (!running)       { dot.className = 'dot';      label.textContent = 'Stopped';   tc.classList.remove('live'); }
        else if (st.locked) { dot.className = 'dot on';   label.textContent = 'Locked';    tc.classList.add('live'); }
        else                { dot.className = 'dot wait'; label.textContent = 'No signal'; tc.classList.remove('live'); }
    }

    // The dropdown ('fps') keeps the user's choice; the meta readout ('fpsDisp')
    // shows the rate actually being transmitted (may be auto-detected).
    if (st.fps) $('fpsDisp').textContent = st.fps;
    if (st.midiName) $('midiname').textContent = st.midiName;
    if ('level' in st) $('level').style.width = Math.min(100, Math.round(st.level * 140)) + '%';
    if ('clients' in st) $('clients').textContent = st.clients + (st.clients === 1 ? ' viewer' : ' viewers');
    if (st.dashUrls) {
        const u = st.dashUrls.lan || st.dashUrls.local || '';
        $('lanurl').value = u || 'unavailable';
    }
    if (st.error) showBanner(st.error);
    if (st.virtual) showBanner('No matching port — created a virtual "LTC to MTC" port. Point your MTC device at it, or enable an IAC bus in Audio MIDI Setup.', true);
});

// ---- Controls ----
$('toggle').addEventListener('click', async () => {
    if (running) { await window.api.stop(); showBanner(''); }
    else { showBanner(''); await window.api.start(currentSettings()); }
});
$('refresh').addEventListener('click', async () => {
    const d = await window.api.refreshDevices();
    const s = currentSettings();
    fillSelect($('audioInput'), d.audioInputs.length ? d.audioInputs : [{ index: s.audioInput, name: 'Default input' }],
        'index', (x) => `[${x.index}] ${x.name}`, s.audioInput);
    const midiItems = d.midiOutputs.slice();
    if (!midiItems.includes(s.midiOut)) midiItems.unshift(s.midiOut);
    if (!midiItems.some((n) => /IAC/i.test(n))) midiItems.push('IAC Driver');
    fillSelect($('midiOut'), midiItems, null, null, s.midiOut);
});
$('gain').addEventListener('input', () => {
    $('gainval').textContent = (+$('gain').value).toFixed(1) + '×';
    window.api.setGain(parseFloat($('gain').value));   // live while running
});
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

// ---- Init ----
(async () => {
    const init = await window.api.getInit();
    await populate(init);
})();
