import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/**
 * 检查指定浏览器的生产 Manifest、权限和随包资源。
 *
 * @param {'edge' | 'chrome'} browserName 要检查的浏览器名称。
 * @returns 该浏览器生产 Manifest 中的版本号。
 */
async function checkBrowserProduction(browserName) {
  const directory = resolve(`.output/${browserName}-mv3`);
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), [
    'favicon',
    'sidePanel',
    'storage',
    'tabGroups',
    'tabs',
  ]);
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.equal(manifest.content_scripts?.length, 1);
  assert.deepEqual(manifest.content_scripts[0].matches, ['<all_urls>']);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.optional_permissions?.length ?? 0, 0);
  assert.equal(manifest.optional_host_permissions?.length ?? 0, 0);
  for (const relative of [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap((script) => script.js),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    'icons/browser/newtab-edge.svg',
    'icons/browser/newtab-chromium.png',
    'icons/browser/LICENSE-fluent.txt',
    'icons/browser/LICENSE-chromium.txt',
    'fonts/Roboto-Latin-Variable.woff2',
    'fonts/LICENSE-roboto.txt',
    'LICENSE-AGPL.txt',
  ]) {
    const path = resolve(directory, relative);
    assert.ok(path.startsWith(`${directory}${sep}`), 'Manifest 入口必须位于产物目录内');
    assert.ok((await stat(path)).isFile(), `产物缺失：${relative}`);
  }
  return manifest.version;
}

/**
 * 检查两种浏览器的 ZIP 产物，并生成可复核的 SHA-256 清单。
 *
 * 两个浏览器的压缩包必须同时存在，避免发布缺少任一目标浏览器的版本。
 *
 * @returns {Promise<void>} 两个压缩包检查完毕并写入校验和后完成。
 */
async function checkProduction() {
  const [edgeVersion, chromeVersion] = await Promise.all([
    checkBrowserProduction('edge'),
    checkBrowserProduction('chrome'),
  ]);
  assert.equal(edgeVersion, chromeVersion, 'Edge 与 Chrome 产物版本不一致');
  const files = await readdir('.output');
  const archives = ['edge', 'chrome'].map(
    (browserName) => `tabstash-${edgeVersion}-${browserName}.zip`,
  );
  // 分别核对两个目标浏览器的文件，明确指出缺失的发布包。
  for (const name of archives) {
    assert.ok(files.includes(name), `缺少 ZIP 生产包：${name}`);
  }
  const hashes = [];
  for (const name of archives) {
    const bytes = await readFile(resolve('.output', name));
    assert.ok(bytes.length >= 4, `ZIP 文件过短：${name}`);
    assert.equal(bytes.readUInt32LE(), 0x04034b50, `ZIP 文件头无效：${name}`);
    hashes.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
  }
  await writeFile('.output/SHA256SUMS.txt', `${hashes.join('\n')}\n`);
  console.log(
    `Edge/Chrome 生产权限、入口和资源检查通过；已为 ${archives.length} 个安装包生成 SHA-256。`,
  );
}

await checkProduction();
