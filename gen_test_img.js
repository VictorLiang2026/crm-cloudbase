// 生成含点阵数字文字的 PNG 测试图（zlib 压缩，用于验证云函数多模态 OCR）
const fs = require('fs');
const zlib = require('zlib');
const FONT = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11111','00010','00100','00010','00001','10001','01110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100'],
};
const TEXT = '13812345678';
const SCALE = 10, MARGIN = 20, GAP = 6;
const W = MARGIN*2 + TEXT.length*(5*SCALE+GAP);
const H = MARGIN*2 + 7*SCALE;
const px = [];
for (let y=0;y<H;y++) px.push(new Array(W).fill(0));
let x0 = MARGIN;
for (const ch of TEXT) {
  const g = FONT[ch];
  for (let r=0;r<7;r++) for (let c=0;c<5;c++) {
    if (g[r][c]==='1') {
      for (let dy=0;dy<SCALE;dy++) for (let dx=0;dx<SCALE;dx++)
        px[MARGIN+r*SCALE+dy][x0+c*SCALE+dx] = 1;
    }
  }
  x0 += 5*SCALE+GAP;
}
// CRC32
const CRCT = (() => { const t=[]; for(let n=0;n<256;n++){ let c=n; for(let k=0;k<8;k++) c = c&1 ? 0xEDB88320^(c>>>1) : c>>>1; t[n]=c>>>0; } return t; })();
function crc32(buf){ let c=0xFFFFFFFF; for(let i=0;i<buf.length;i++) c = CRCT[(c^buf[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; }
function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// 扫描线：filter 0 + RGB
const raw = Buffer.alloc(H*(W*3+1));
for (let y=0;y<H;y++){
  raw[y*(W*3+1)] = 0;
  for (let x=0;x<W;x++){
    const v = px[y][x] ? 0 : 255;
    const off = y*(W*3+1)+1+x*3;
    raw[off]=v; raw[off+1]=v; raw[off+2]=v;
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4);
ihdr[8]=8; ihdr[9]=2; // 8bit RGB
const png = Buffer.concat([
  Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, {level:9})),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(__dirname+'/test_ocr.png', png);
fs.writeFileSync(__dirname+'/test_ocr.b64', png.toString('base64'));
console.log('PNG', W+'x'+H, png.length, 'bytes, b64', Buffer.byteLength(png.toString('base64')));
