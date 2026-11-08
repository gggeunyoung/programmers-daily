#!/usr/bin/env node
// 배포용 zip 만들기: dist/coding-daily-<버전>.zip (manifest.json · icons · src 만 담는다)
// 크롬 웹스토어 업로드나 친구에게 파일로 넘길 때 쓴다. 외부 패키지 없이 Node 내장 zlib 만 사용.
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['manifest.json', 'icons', 'src'];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function walk(rel) {
  const abs = path.join(root, rel);
  if ((await stat(abs)).isFile()) return [rel];
  const out = [];
  for (const name of (await readdir(abs)).sort()) out.push(...(await walk(path.join(rel, name))));
  return out;
}

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

// 아이콘 원본(SVG)은 빌드용이라 패키지에서 뺀다
const files = (await Promise.all(INCLUDE.map(walk))).flat().filter((f) => !f.split(path.sep).join('/').startsWith('icons/src/'));
const now = new Date();
const parts = [];
const central = [];
let offset = 0;

for (const rel of files) {
  const name = Buffer.from(rel.split(path.sep).join('/'), 'utf8');
  const data = await readFile(path.join(root, rel));
  const deflated = deflateRawSync(data, { level: 9 });
  const method = deflated.length < data.length ? 8 : 0;
  const body = method ? deflated : data;
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // 파일 이름 UTF-8
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime(now), 10);
  local.writeUInt16LE(dosDate(now), 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  parts.push(local, name, body);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(method, 10);
  entry.writeUInt16LE(dosTime(now), 12);
  entry.writeUInt16LE(dosDate(now), 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(body.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42); // 나머지 필드는 0
  central.push(entry, name);

  offset += local.length + name.length + body.length;
}

const centralSize = central.reduce((a, b) => a + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const { version } = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
await mkdir(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `coding-daily-${version}.zip`);
await writeFile(out, Buffer.concat([...parts, ...central, end]));
console.log(`생성: ${path.relative(root, out)} (${files.length}개 파일)`);
