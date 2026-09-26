import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const version = '154.0.8037.57';
const root = resolve('.tmp/chrome-for-testing');
const directory = resolve(root, version);
const executable = resolve(directory, 'chrome-win64/chrome.exe');
const pathFile = resolve(root, 'executable-path.txt');
const archive = resolve(root, `chrome-${version}-win64.zip`);
const downloadUrl = `https://storage.googleapis.com/chrome-for-testing-public/${version}/win64/chrome-win64.zip`;
const mirrorUrl = `https://cdn.npmmirror.com/binaries/chrome-for-testing/${version}/win64/chrome-win64.zip`;
const expectedSha256 = '676f51fb82608330db5510ffba53d9e2762d3d7a99464afce54f9e9e25ad6bf7';

/** @param file 需要检查的文件。@returns 文件存在时为 true。 */
async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** @returns 本地 ZIP 与已核对的固定版本 SHA-256 一致时为 true。 */
async function archiveValid() {
  if (!(await exists(archive))) return false;
  const bytes = await readFile(archive);
  return (
    bytes.length >= 4 &&
    bytes.readUInt32LE(0) === 0x04034b50 &&
    createHash('sha256').update(bytes).digest('hex') === expectedSha256
  );
}

/** 先尝试镜像，再回退官方地址；两种来源都必须通过同一个固定哈希。 */
async function download() {
  for (const url of [mirrorUrl, downloadUrl]) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
      if (await archiveValid()) return;
      console.warn(`下载校验失败，改试另一来源：${url}`);
    } catch (error) {
      console.warn(`Chrome 下载失败，改试另一来源：${url}`, error);
    }
  }
  throw new Error('Chrome for Testing 下载或 SHA-256 校验失败');
}

/** 为本次测试保留已验证哈希，便于排查镜像内容。 */
async function writeArchiveHash() {
  await writeFile(
    resolve(root, `chrome-${version}-sha256.txt`),
    `${expectedSha256}  chrome-${version}-win64.zip\n`,
  );
}

/** 使用 Windows 自带 bsdtar 解压，避免修改系统浏览器安装。 */
async function extract() {
  await mkdir(directory, { recursive: true });
  await new Promise((accept, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', directory], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? accept() : reject(new Error(`Chrome 解压失败：${code}`)),
    );
  });
}

await mkdir(root, { recursive: true });
if (!(await exists(executable))) {
  if (!(await archiveValid())) await download();
  await writeArchiveHash();
  await extract();
}
if (!(await exists(executable))) throw new Error('Chrome for Testing 可执行文件缺失');
await writeFile(pathFile, `${executable}\n`);
console.log(`Chrome for Testing ${version} 已就绪：${executable}`);
