const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("highlightAI", {
  chooseFolder: () => ipcRenderer.invoke("highlightai:choose-folder"),
  showItemInFolder: (filePath) => ipcRenderer.invoke("highlightai:show-item-in-folder", filePath)
});
