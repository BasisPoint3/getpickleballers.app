// A small QR code encoder for live.html (docs/LIVE_LINK.md): byte mode, error
// correction level M, versions 1 to 10 (up to 213 characters), the mask picked
// by the standard's penalty score. Written out here so the page has nothing
// to load from anywhere else. Follows ISO/IEC 18004; the structure is the one
// Project Nayuki's reference encoder uses.
//
//   QR.encode('https://…')  → { size, get(x, y), mask, version }
//   QR.svg('https://…')     → an SVG string, one path, viewBox in modules
window.QR = (function () {
  const ECC_M = { bits: 0, perBlock: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], blocks: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5] };
  const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  function rawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const a = Math.floor(ver / 7) + 2;
      n -= (25 * a - 10) * a - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }
  const codewords = (ver) => Math.floor(rawModules(ver) / 8);
  const dataCodewords = (ver) => codewords(ver) - ECC_M.perBlock[ver] * ECC_M.blocks[ver];

  // GF(256) with the QR polynomial.
  function mul(a, b) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((b >>> i) & 1) * a;
    }
    return z & 0xFF;
  }
  function rsGenerator(degree) {
    const g = new Array(degree).fill(0);
    g[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        g[j] = mul(g[j], root);
        if (j + 1 < degree) g[j] ^= g[j + 1];
      }
      root = mul(root, 2);
    }
    return g;
  }
  function rsRemainder(data, gen) {
    const r = new Array(gen.length).fill(0);
    for (const b of data) {
      const f = b ^ r.shift();
      r.push(0);
      for (let j = 0; j < gen.length; j++) r[j] ^= mul(gen[j], f);
    }
    return r;
  }

  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 1;
    while (ver <= 10 && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
    if (ver > 10) throw new Error('QR: too long');

    // Segment bits: mode, count, data, terminator, padding.
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    push(4, 4);
    push(bytes.length, ver <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    const cap = dataCodewords(ver) * 8;
    push(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (let pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

    // Error correction, interleaved.
    const numBlocks = ECC_M.blocks[ver];
    const eccLen = ECC_M.perBlock[ver];
    const raw = codewords(ver);
    const shortBlocks = numBlocks - (raw % numBlocks);
    const shortLen = Math.floor(raw / numBlocks);
    const gen = rsGenerator(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
      const dat = data.slice(k, k + len);
      k += len;
      const ecc = rsRemainder(dat, gen);
      if (i < shortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const all = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) all.push(b[i]); });
    }

    // The grid.
    const size = ver * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = ALIGN[ver];
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    const formatBits = (mask) => {
      const d = (ECC_M.bits << 3) | mask;
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bitsOut = ((d << 10) | rem) ^ 0x5412;
      const bit = (i) => ((bitsOut >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    formatBits(0);
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const v = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((v >>> i) & 1) === 1;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, bit); set(b, a, bit);
      }
    }

    // Data, zigzagging up and down in column pairs from the right.
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          if (!fn[y][x] && i < all.length * 8) {
            m[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
        }
      }
    }

    // The mask with the lowest penalty.
    const maskAt = (k, x, y) => {
      switch (k) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5: return (x * y) % 2 + (x * y) % 3 === 0;
        case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
        default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
      }
    };
    const applyMask = (k) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskAt(k, x, y)) m[y][x] = !m[y][x];
    };
    const penalty = () => {
      let p = 0;
      const runs = (line) => {
        let run = 0, prev = null;
        for (let i = 0; i <= line.length; i++) {
          const c = line[i];
          if (c === prev) run++;
          else { if (run >= 5) p += 3 + run - 5; run = 1; prev = c; }
        }
        const s = line.map((c) => (c ? '1' : '0')).join('');
        for (const pat of ['10111010000', '00001011101']) {
          let at = -1;
          while ((at = s.indexOf(pat, at + 1)) >= 0) p += 40;
        }
      };
      for (let y = 0; y < size; y++) runs(m[y]);
      for (let x = 0; x < size; x++) runs(m.map((row) => row[x]));
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
      }
      let dark = 0;
      for (const row of m) for (const c of row) if (c) dark++;
      const k = Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1;
      return p + k * 10;
    };
    let best = 0, bestScore = Infinity;
    for (let k = 0; k < 8; k++) {
      applyMask(k);
      formatBits(k);
      const s = penalty();
      if (s < bestScore) { bestScore = s; best = k; }
      applyMask(k);
    }
    applyMask(best);
    formatBits(best);

    return { size, version: ver, mask: best, get: (x, y) => m[y][x], rows: m };
  }

  function svg(text, quiet = 2) {
    const q = encode(text);
    const n = q.size + quiet * 2;
    let d = '';
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.get(x, y)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  return { encode, svg };
})();
