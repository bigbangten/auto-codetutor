import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

function canonical(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function isPathInside(root: string, candidate: string): boolean {
  const base = canonical(root);
  const target = canonical(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

export function resolveRelative(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error('프로젝트 상대 경로만 사용할 수 있습니다.');
  }
  const candidate = path.resolve(root, relativePath);
  if (!isPathInside(root, candidate)) throw new Error('프로젝트 밖의 경로는 열 수 없습니다.');
  return candidate;
}

export async function resolveReadableFile(root: string, relativePath: string): Promise<string> {
  const rootReal = await realpath(root);
  const candidate = resolveRelative(rootReal, relativePath);
  const targetReal = await realpath(candidate);
  if (!isPathInside(rootReal, targetReal)) throw new Error('심볼릭 링크가 프로젝트 밖을 가리킵니다.');
  const stat = await lstat(targetReal);
  if (!stat.isFile()) throw new Error('파일이 아닙니다.');
  return targetReal;
}

export async function ensureProjectDataDir(root: string): Promise<string> {
  const rootReal = await realpath(root);
  const dataDir = path.join(rootReal, '.codetutor-next');
  try {
    const stat = await lstat(dataDir);
    if (stat.isSymbolicLink()) throw new Error('.codetutor-next가 심볼릭 링크여서 사용할 수 없습니다.');
    if (!stat.isDirectory()) throw new Error('.codetutor-next가 폴더가 아닙니다.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dataDir, { recursive: false });
  }
  const dataReal = await realpath(dataDir);
  if (!isPathInside(rootReal, dataReal)) throw new Error('프로젝트 데이터 폴더가 범위를 벗어났습니다.');
  return dataReal;
}

export function normalizeRelative(root: string, absolutePath: string): string {
  if (!isPathInside(root, absolutePath)) throw new Error('프로젝트 밖의 파일입니다.');
  return path.relative(root, absolutePath).split(path.sep).join('/');
}
