import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(".");
const items = JSON.parse(await readFile(path.join(root, "data-battlefield", "top60.json"), "utf8"));
const output = path.join(root, "data-battlefield", "vision-review");
const frames = path.join(output, "frames");
await mkdir(frames, { recursive: true });
const ffmpeg = path.join(root, "vendor", "ffmpeg", "ffmpeg.exe");

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.slice(-1000))));
  });
}

for (let index = 0; index < items.length; index += 1) {
  const item = items[index];
  const label = String(index + 1).padStart(2, "0");
  item.reviewIndex = index + 1;
  item.frame = path.join(frames, `${label}.jpg`);
  await run([
    "-y", "-hide_banner", "-loglevel", "error", "-ss", String(item.start), "-i", item.path, "-frames:v", "1",
    "-vf", `scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black,drawbox=x=0:y=0:w=76:h=48:color=black@0.75:t=fill,drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':text='${label}':fontcolor=white:fontsize=28:x=18:y=8`,
    "-q:v", "2", item.frame
  ]);
}

for (let page = 0; page < 4; page += 1) {
  const pageItems = items.slice(page * 15, page * 15 + 15);
  const list = pageItems.map((item) => `file '${item.frame.replaceAll("\\", "/").replaceAll("'", "'\\''")}'\nduration 1`).join("\n");
  const listPath = path.join(output, `page-${page + 1}.txt`);
  await writeFile(listPath, list);
  await run([
    "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", "fps=1,tile=3x5:padding=8:margin=12:color=0x101317", "-frames:v", "1",
    path.join(output, `page-${page + 1}.jpg`)
  ]);
}
await writeFile(path.join(output, "candidates.json"), JSON.stringify(items, null, 2));
