import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

/** 计算 PNG 块的 CRC32，生成图标无需额外图像库。 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {string} type PNG 块类型。@param {Buffer} data 块内容。 */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}

/**
 * 以叠放标签页与收纳盒绘制 TabStash 图标；坐标归一化以适应所有尺寸。
 * @param {number} size 输出边长，采用四倍采样减少斜线和边角锯齿。
 */
function icon(size) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  /** 按图层返回指定采样点的 RGBA 颜色。 */
  function color(x, y) {
    const cornerX = Math.max(0.16 - x, x - 0.84, 0);
    const cornerY = Math.max(0.16 - y, y - 0.84, 0);
    if (cornerX * cornerX + cornerY * cornerY > 0.16 ** 2) return [0, 0, 0, 0];
    if (x > 0.32 && x < 0.75 && y > 0.22 && y < 0.56) return [159, 207, 255, 255];
    if (x > 0.24 && x < 0.67 && y > 0.31 && y < 0.58) return [241, 248, 255, 255];
    if (x > 0.21 && x < 0.79 && y > 0.58 && y < 0.79) {
      if (x > 0.41 && x < 0.59 && y < 0.64) return [36, 90, 155, 255];
      return [241, 248, 255, 255];
    }
    return [36, 90, 155, 255];
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const sample = color((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
          for (let channel = 0; channel < 4; channel++) sum[channel] += sample[channel];
        }
      }
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      for (let channel = 0; channel < 4; channel++)
        pixels[offset + channel] = Math.round(sum[channel] / 16);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir('public/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) await writeFile(`public/icons/${size}.png`, icon(size));
