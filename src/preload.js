const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  processRecording: (arrayBuffer) => ipcRenderer.invoke('recording:process', arrayBuffer),
  testConnections: (settings) => ipcRenderer.invoke('diagnostics:test', settings),
  checkReadiness: (settings) => ipcRenderer.invoke('readiness:check', settings),
  listOllamaModels: (url) => ipcRenderer.invoke('ollama:models', url),
  listAnthropicModels: (key) => ipcRenderer.invoke('anthropic:models', key),
  listOpenaiModels: (key) => ipcRenderer.invoke('openai:models', key),
  createClickupTask: (item, summary, parentId) => ipcRenderer.invoke('clickup:create', { item, summary, parentId }),
  getClickupListUrl: () => ipcRenderer.invoke('clickup:listUrl'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  // Meetings library
  listMeetings: () => ipcRenderer.invoke('meetings:list'),
  updateMeeting: (id, patch) => ipcRenderer.invoke('meetings:update', { id, patch }),
  deleteMeeting: (id) => ipcRenderer.invoke('meetings:delete', id),
  onProgress: (cb) => {
    const handler = (_e, message) => cb(message);
    ipcRenderer.on('progress', handler);
    return () => ipcRenderer.removeListener('progress', handler);
  },
});
