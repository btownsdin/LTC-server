// Safe bridge between the renderer (capture + decode + UI) and main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getInit:       ()         => ipcRenderer.invoke('get-init'),
    refreshMidi:   ()         => ipcRenderer.invoke('refresh-midi'),
    engineStart:   (settings) => ipcRenderer.invoke('engine-start', settings),
    engineStop:    ()         => ipcRenderer.invoke('engine-stop'),
    sendFrame:     (frame)    => ipcRenderer.invoke('frame', frame),
    saveSettings:  (settings) => ipcRenderer.invoke('save-settings', settings),
    openDashboard: ()         => ipcRenderer.invoke('open-dashboard'),
    setDashPort:   (port)     => ipcRenderer.invoke('set-dash-port', port),
    onStatus:      (cb)       => ipcRenderer.on('status', (_e, data) => cb(data)),
});
