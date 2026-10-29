// Fast Fourier transform (radix 2, in place, double precision) for FFT convolution of the
// display filters. Plain ES module, no dependencies.

const plans = new Map();

/**
 * A complex FFT of one power-of-two size. The forward transform uses exp(-2 pi i k n / N); the
 * inverse uses the conjugate twiddles and divides by N, so inverse(forward(x)) == x.
 */
export class FFT {
  /** @param {number} n a power of two, at least 4 */
  constructor(n) {
    if (n < 4 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two >= 4, got ${n}`);
    this.n = n;
    let bits = 0;
    while (1 << bits < n) bits++;
    this.bits = bits;
    const rev = new Uint32Array(n);
    for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
    this.rev = rev;
    // Twiddles of every stage from size 8 upwards, stored one stage after another so that the
    // inner loop reads them in order: stage `size` holds cos and sin of 2 pi j / size, j < size/2.
    let total = 0;
    for (let size = 8; size <= n; size <<= 1) total += size >> 1;
    this.twr = new Float64Array(total);
    this.twi = new Float64Array(total);
    this.offsets = new Map();
    let off = 0;
    for (let size = 8; size <= n; size <<= 1) {
      const half = size >> 1;
      this.offsets.set(size, off);
      for (let j = 0; j < half; j++) {
        const angle = (2 * Math.PI * j) / size;
        this.twr[off + j] = Math.cos(angle);
        this.twi[off + j] = Math.sin(angle);
      }
      off += half;
    }
  }

  /** The shared plan for size n. @param {number} n */
  static of(n) {
    let p = plans.get(n);
    if (!p) {
      p = new FFT(n);
      plans.set(n, p);
    }
    return p;
  }

  /** In-place forward transform. @param {Float64Array} re @param {Float64Array} im */
  forward(re, im) {
    this._transform(re, im, -1);
  }

  /** In-place inverse transform, scaled by 1/N. @param {Float64Array} re @param {Float64Array} im */
  inverse(re, im) {
    this._transform(re, im, 1);
    const s = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }

  /** @param {Float64Array} re @param {Float64Array} im @param {number} sign -1 forward, +1 inverse */
  _transform(re, im, sign) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    // Sizes 2 and 4 together: twiddles 1 and -/+ i need no multiplication.
    for (let i = 0; i < n; i += 4) {
      const r0 = re[i], i0 = im[i], r1 = re[i + 1], i1 = im[i + 1];
      const r2 = re[i + 2], i2 = im[i + 2], r3 = re[i + 3], i3 = im[i + 3];
      const ar = r0 + r1, ai = i0 + i1, br = r0 - r1, bi = i0 - i1;
      const cr = r2 + r3, ci = i2 + i3, dr = r2 - r3, di = i2 - i3;
      // d times the twiddle of index 1 at size 4: -i (forward) or +i (inverse)
      const tr = sign < 0 ? di : -di;
      const ti = sign < 0 ? -dr : dr;
      re[i] = ar + cr;
      im[i] = ai + ci;
      re[i + 2] = ar - cr;
      im[i + 2] = ai - ci;
      re[i + 1] = br + tr;
      im[i + 1] = bi + ti;
      re[i + 3] = br - tr;
      im[i + 3] = bi - ti;
    }
    const twr = this.twr;
    const twi = this.twi;
    const offsets = this.offsets;
    // Two radix-2 stages per pass (sizes 2h and 4h), which halves the passes over the data.
    let h = 4;
    while (4 * h <= n) {
      const o1 = offsets.get(2 * h);
      const o2 = offsets.get(4 * h);
      const size = 4 * h;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < h; j++) {
          const i0 = start + j;
          const i1 = i0 + h;
          const i2 = i1 + h;
          const i3 = i2 + h;
          const w1r = twr[o1 + j];
          const w1i = sign * twi[o1 + j];
          const w2r = twr[o2 + j];
          const w2i = sign * twi[o2 + j];
          // stage of size 2h: (x0, x1) and (x2, x3) with w1
          let xr = re[i1], xi = im[i1];
          let tr = w1r * xr - w1i * xi;
          let ti = w1r * xi + w1i * xr;
          const x0r = re[i0], x0i = im[i0];
          const y0r = x0r + tr, y0i = x0i + ti;
          const y1r = x0r - tr, y1i = x0i - ti;
          xr = re[i3];
          xi = im[i3];
          tr = w1r * xr - w1i * xi;
          ti = w1r * xi + w1i * xr;
          const x2r = re[i2], x2i = im[i2];
          const y2r = x2r + tr, y2i = x2i + ti;
          const y3r = x2r - tr, y3i = x2i - ti;
          // stage of size 4h: (y0, y2) with w2 and (y1, y3) with w2 times -/+ i
          tr = w2r * y2r - w2i * y2i;
          ti = w2r * y2i + w2i * y2r;
          re[i0] = y0r + tr;
          im[i0] = y0i + ti;
          re[i2] = y0r - tr;
          im[i2] = y0i - ti;
          const ur = w2r * y3r - w2i * y3i;
          const ui = w2r * y3i + w2i * y3r;
          // multiply by -i (forward) or +i (inverse)
          tr = sign < 0 ? ui : -ui;
          ti = sign < 0 ? -ur : ur;
          re[i1] = y1r + tr;
          im[i1] = y1i + ti;
          re[i3] = y1r - tr;
          im[i3] = y1i - ti;
        }
      }
      h *= 4;
    }
    if (2 * h <= n) {
      const off = offsets.get(2 * h);
      const size = 2 * h;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < h; j++) {
          const a = start + j;
          const b = a + h;
          const wr = twr[off + j];
          const wi = sign * twi[off + j];
          const xr = re[b];
          const xi = im[b];
          const tr = wr * xr - wi * xi;
          const ti = wr * xi + wi * xr;
          const ur = re[a];
          const ui = im[a];
          re[a] = ur + tr;
          im[a] = ui + ti;
          re[b] = ur - tr;
          im[b] = ui - ti;
        }
      }
    }
  }
}

/** The smallest power of two that is at least n (and at least 4). @param {number} n */
export function nextPow2(n) {
  let p = 4;
  while (p < n) p *= 2;
  return p;
}

/**
 * The spectrum of a real kernel zero-padded to size n.
 * @param {Float64Array} h
 * @param {number} n
 * @returns {{re: Float64Array, im: Float64Array}}
 */
export function kernelSpectrum(h, n) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(h);
  FFT.of(n).forward(re, im);
  return { re, im };
}
