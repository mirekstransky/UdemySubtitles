// Generate minimal solid-color PNG icons using only Node.js built-ins.
// Color: #7c3aed (purple)
const { createHash } = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function makePng(size, r, g, b) {
  function chunk(tag, data) {
    const buf = Buffer.concat([tag, data]);
    const crc = crc32(buf);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0, 0);
    return Buffer.concat([len, buf, crcBuf]);
  }

  // CRC32 implementation
  function crc32(buf) {
    const table = makeCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c;
    }
    return table;
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk(Buffer.from('IHDR'), ihdrData);

  // Raw image data
  const rowLen = 1 + size * 3; // filter byte + RGB pixels
  const raw = Buffer.alloc(size * rowLen);
  for (let y = 0; y < size; y++) {
    const base = y * rowLen;
    raw[base] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[base + 1 + x * 3] = r;
      raw[base + 1 + x * 3 + 1] = g;
      raw[base + 1 + x * 3 + 2] = b;
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const idat = chunk(Buffer.from('IDAT'), compressed);

  const iend = chunk(Buffer.from('IEND'), Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir);

for (const size of [16, 48, 128]) {
  const data = makePng(size, 0x7c, 0x3a, 0xed);
  const outPath = path.join(imagesDir, `icon${size}.png`);
  fs.writeFileSync(outPath, data);
  console.log(`  Created ${outPath} (${size}x${size}, ${data.length} bytes)`);
}
console.log('Done.');
