// Safe, minimal bridge between the renderer (settings GUI) and main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getInit:        ()          => ipcRenderer.invoke('get-init'),
    refreshDevices: ()          => ipcRenderer.invoke('refresh-devices'),
    start:          (settings)  => ipcRenderer.invoke('start', settings),
    stop:           ()          => ipcRenderer.invoke('stop'),
    saveSettings:   (settings)  => ipcRenderer.invoke('save-settings', settings),
    setGain:        (g)         => ipcRenderer.invoke('set-gain', g),
    openDashboard:  ()          => ipcRenderer.invoke('open-dashboard'),
    setDashPort:    (port)      => ipcRenderer.invoke('set-dash-port', port),
    onStatus:       (cb)        => ipcRenderer.on('status', (_e, data) => cb(data)),
});
