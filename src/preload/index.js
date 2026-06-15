import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("meetingApi", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  createRealtimeToken: (options) =>
    ipcRenderer.invoke("openai:create-realtime-token", options),
  analyzeMeeting: (payload) => ipcRenderer.invoke("meeting:analyze", payload),
  exportMinutes: (payload) => ipcRenderer.invoke("meeting:export", payload),
});
