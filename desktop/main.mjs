import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitForApi() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:4312/api/health");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The local HighlightAI service did not start.");
}

async function resolveDevUrl() {
  const candidates = [
    process.env.HIGHLIGHTAI_DEV_URL,
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:5174",
    "http://localhost:5174",
    "http://127.0.0.1:5175",
    "http://localhost:5175"
  ].filter(Boolean);
  for (const url of candidates) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(url);
        if (response.ok) return url;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`The Vite dev server did not respond. Tried: ${candidates.join(", ")}`);
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 930,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#eef3ec",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(root, "desktop", "preload.cjs")
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  const splash = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;background:#eef3ec;color:#172019;font-family:Segoe UI,Arial,sans-serif}
    main{text-align:center}.mark{width:58px;height:58px;margin:0 auto 22px;display:grid;place-items:center;border-radius:17px;background:#72d51f;color:#0b1607;font-size:30px;font-weight:800;box-shadow:0 18px 45px rgba(77,139,27,.2)}
    h1{margin:0;font-size:28px;letter-spacing:-1px}.ai{color:#4b9b13}p{margin:9px 0 22px;color:#667168;font-size:13px}
    .bar{width:210px;height:5px;margin:auto;overflow:hidden;border-radius:99px;background:#d6dfd3}.bar:after{content:"";display:block;width:42%;height:100%;border-radius:inherit;background:#72d51f;animation:load 1.05s ease-in-out infinite}
    @keyframes load{0%{transform:translateX(-110%)}100%{transform:translateX(350%)}}@media(prefers-color-scheme:dark){body{background:#080c0f;color:#f2f6f2}p{color:#7c877e}.bar{background:#202821}}
  </style></head><body><main><div class="mark">*</div><h1>Highlight<span class="ai">AI</span></h1><p>Starting your local video workspace...</p><div class="bar"></div></main></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splash)}`);
  if (!process.argv.includes("--dev")) {
    process.env.HIGHLIGHTAI_DATA_ROOT = path.join(app.getPath("userData"), "data");
    process.env.HIGHLIGHTAI_FFMPEG_DIR = path.join(root, "vendor", "ffmpeg");
    await import(pathToFileURL(path.join(root, "server", "index.mjs")).href);
  }
  await waitForApi();
  await window.loadURL(process.argv.includes("--dev") ? await resolveDevUrl() : "http://127.0.0.1:4312");
}

ipcMain.handle("highlightai:choose-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Choose your gameplay recordings folder" });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("highlightai:show-item-in-folder", async (_, filePath) => {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return false;
  shell.showItemInFolder(filePath);
  return true;
});

app.whenReady().then(() => createWindow().catch((error) => {
  dialog.showErrorBox("HighlightAI could not start", error.message);
  app.quit();
}));
app.on("window-all-closed", () => app.quit());
