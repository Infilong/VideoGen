import { copyFile } from "node:fs/promises";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const jsonWriteQueues = new Map();
const transientReplaceErrors = new Set(["EACCES", "EBUSY", "EPERM"]);

async function writeJsonAtomically(filePath, serialized) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(tempPath, serialized);
    let lastError;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      try {
        await rename(tempPath, filePath);
        return;
      } catch (error) {
        lastError = error;
        if (!transientReplaceErrors.has(error?.code) || attempt === 6) break;
        await new Promise((resolve) => setTimeout(resolve, 20 * (2 ** attempt)));
      }
    }
    if (process.platform !== "win32" || !transientReplaceErrors.has(lastError?.code)) throw lastError;
    await copyFile(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export function saveJson(filePath, data) {
  const serialized = JSON.stringify(data, null, 2);
  const previous = jsonWriteQueues.get(filePath) || Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => writeJsonAtomically(filePath, serialized));
  jsonWriteQueues.set(filePath, operation);
  operation.finally(() => {
    if (jsonWriteQueues.get(filePath) === operation) jsonWriteQueues.delete(filePath);
  }).catch(() => undefined);
  return operation;
}

export async function loadJson(filePath) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      lastError = error;
      if (!(error instanceof SyntaxError) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
  throw lastError;
}
