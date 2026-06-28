import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceDir = process.argv[2] || "D:\\Download\\Battlefield 6";
const workDir = process.argv[3] || path.resolve("trailer-work");
const ffmpeg = path.resolve("vendor/ffmpeg/ffmpeg.exe");
const ffprobe = path.resolve("vendor/ffmpeg/ffprobe.exe");
const thumbsDir = path.join(workDir, "thumbs");
await mkdir(thumbsDir, { recursive: true });

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.slice(-1500))));
  });
}

async function inspect(file, index) {
  const probe = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", file]);
  const parsed = JSON.parse(probe.stdout);
  const duration = Number(parsed.format.duration || 0);
  const start = Math.max(0, duration - Math.min(35, duration * 0.55));
  const analysis = await run(ffmpeg, [
    "-hide_banner", "-ss", String(start), "-t", "24", "-i", file,
    "-vf", "scale=320:-2,select='gt(scene,0.16)',metadata=print",
    "-af", "volumedetect", "-f", "null", "-"
  ]);
  const sceneScores = [...analysis.stderr.matchAll(/lavfi\.scene_score=([\d.]+)/g)].map((match) => Number(match[1]));
  const maxVolume = Number(analysis.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1] || -40);
  const meanVolume = Number(analysis.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1] || -40);
  const sceneEnergy = sceneScores.reduce((sum, value) => sum + value, 0);
  const score = sceneEnergy * 16 + sceneScores.length * 2 + Math.max(0, 24 + meanVolume) + Math.max(0, 8 + maxVolume);
  const thumb = path.join(thumbsDir, `${String(index).padStart(3, "0")}.jpg`);
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, duration - 18)), "-i", file,
    "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "3", thumb
  ]);
  return { index, file, duration, start, score: Math.round(score * 10) / 10, sceneCuts: sceneScores.length, sceneEnergy, meanVolume, maxVolume, thumb };
}

const files = (await readdir(sourceDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.mp4$/i.test(entry.name))
  .map((entry) => path.join(sourceDir, entry.name));
const results = [];
let cursor = 0;
async function worker() {
  while (cursor < files.length) {
    const index = cursor++;
    try {
      const result = await inspect(files[index], index);
      results.push(result);
      console.log(`[${results.length}/${files.length}] ${path.basename(result.file)} score=${result.score}`);
    } catch (error) {
      console.error(`[failed] ${path.basename(files[index])}: ${error.message}`);
    }
  }
}
await Promise.all([worker(), worker(), worker()]);
results.sort((a, b) => b.score - a.score);
await writeFile(path.join(workDir, "analysis.json"), JSON.stringify(results, null, 2));

const top = results.slice(0, 48);
const concat = top.map((item) => `file '${item.thumb.replaceAll("\\", "/").replaceAll("'", "'\\''")}'\nduration 1`).join("\n");
await writeFile(path.join(workDir, "top-thumbs.txt"), concat);
await run(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(workDir, "top-thumbs.txt"),
  "-vf", "fps=1,scale=480:-2,tile=6x8:padding=6:margin=12:color=0x111111",
  "-frames:v", "1", path.join(workDir, "top-48-contact-sheet.jpg")
]);
console.log(`Analysis written to ${path.join(workDir, "analysis.json")}`);
