import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export function safeId(prefix = ''): string {
  return `${prefix}${crypto.randomUUID()}`;
}
