import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

function locate(command) {
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  return execFileSync(resolver, [command], { encoding: "utf8" }).trim().split(/\r?\n/)[0];
}

const ffmpegPath = locate("ffmpeg");
const sourceDir = path.dirname(ffmpegPath);
const destination = path.resolve("vendor", "ffmpeg");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

const files = await readdir(sourceDir);
const needed = files.filter((name) => /^(ffmpeg|ffprobe)(\.exe)?$/i.test(name) || /\.dll$/i.test(name));
for (const name of needed) await copyFile(path.join(sourceDir, name), path.join(destination, name));
console.log(`Bundled ${needed.length} FFmpeg runtime files from ${sourceDir}`);
