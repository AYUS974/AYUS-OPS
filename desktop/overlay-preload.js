// Preload for the floating assistant overlay. Bridges the three desktop-only
// powers the pill needs into its (context-isolated) page: grab the screen,
// resize the window to fit its content, and hide itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ayus", {
  captureScreen: () => ipcRenderer.invoke("capture-screen"),
  resize: (height) => ipcRenderer.send("overlay-resize", height),
  hide: () => ipcRenderer.send("overlay-hide"),
});
