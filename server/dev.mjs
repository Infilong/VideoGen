import { spawn } from "node:child_process";

const api = spawn(process.execPath, ["server/index.mjs"], { stdio: "inherit", windowsHide: true });
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit", windowsHide: true });

function shutdown() {
  api.kill();
  vite.kill();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
