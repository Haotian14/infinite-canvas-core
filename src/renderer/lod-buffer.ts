/**
 * A pixel buffer for shapes too small to be worth a draw call.
 *
 * Below roughly a pixel, a rectangle's geometry is not resolvable: all the
 * viewer perceives is a coloured dot. Each `ctx.rect()` still costs a JS-to-C++
 * boundary crossing though — at a hundred thousand nodes that alone is most of
 * the frame. Writing straight into an `ImageData` makes each of those shapes a
 * handful of typed-array stores instead.
 *
 * Only the touched region is uploaded and only touched pixels are cleared, so
 * cost tracks the number of small shapes rather than the size of the viewport.
 */
export class LodBuffer {
  private _canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private _ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private _image: ImageData | null = null;
  private _pixels: Uint32Array | null = null;
  private _width = 0;
  private _height = 0;

  /**
   * Indices written this frame, so clearing costs O(written) not O(viewport).
   * A preallocated typed array rather than `number[]`: at a hundred thousand
   * shapes a frame, `push` and its reallocations were the single hottest line
   * in the profile.
   */
  private _touched = new Int32Array(4096);
  private _touchedCount = 0;
  private _minX = 0;
  private _minY = 0;
  private _maxX = 0;
  private _maxY = 0;

  /** CSS colour string to a packed pixel, parsed once by the canvas itself. */
  private _colors = new Map<string, number>();
  private _probe: CanvasRenderingContext2D | null = null;
  /** Shapes arrive grouped by colour often enough that one slot pays for itself. */
  private _lastColor = '';
  private _lastPacked = 0;

  resize(deviceWidth: number, deviceHeight: number): void {
    if (deviceWidth === this._width && deviceHeight === this._height) return;
    this._width = deviceWidth;
    this._height = deviceHeight;

    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(deviceWidth, deviceHeight)
        : Object.assign(document.createElement('canvas'), {
            width: deviceWidth,
            height: deviceHeight,
          });
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this._image = this._ctx.createImageData(deviceWidth, deviceHeight);
    this._pixels = new Uint32Array(this._image.data.buffer);
    this._touchedCount = 0;
  }

  beginFrame(): void {
    const pixels = this._pixels;
    if (pixels === null) return;

    // Past a quarter of the viewport, a bulk clear beats walking the list.
    if (this._touchedCount > pixels.length / 4) {
      pixels.fill(0);
    } else {
      const touched = this._touched;
      for (let i = 0; i < this._touchedCount; i++) pixels[touched[i] as number] = 0;
    }

    this._touchedCount = 0;
    this._minX = this._width;
    this._minY = this._height;
    this._maxX = -1;
    this._maxY = -1;
  }

  /** Paints a device-pixel box. `w`/`h` are clamped to at least one pixel. */
  plot(x: number, y: number, w: number, h: number, color: string): void {
    const pixels = this._pixels;
    if (pixels === null) return;

    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this._width - 1, Math.floor(x + Math.max(w, 1)) - 1);
    const y1 = Math.min(this._height - 1, Math.floor(y + Math.max(h, 1)) - 1);
    if (x1 < x0 || y1 < y0) return;

    const packed = color === this._lastColor ? this._lastPacked : this._pack(color);
    const needed = this._touchedCount + (x1 - x0 + 1) * (y1 - y0 + 1);
    if (needed > this._touched.length) this._growTouched(needed);
    const touched = this._touched;
    let count = this._touchedCount;

    if (x0 === x1 && y0 === y1) {
      // Overwhelmingly the common case once shapes are sub-pixel.
      const index = y0 * this._width + x0;
      pixels[index] = packed;
      touched[count++] = index;
    } else {
      for (let py = y0; py <= y1; py++) {
        const row = py * this._width;
        for (let px = x0; px <= x1; px++) {
          const index = row + px;
          pixels[index] = packed;
          touched[count++] = index;
        }
      }
    }
    this._touchedCount = count;

    if (x0 < this._minX) this._minX = x0;
    if (y0 < this._minY) this._minY = y0;
    if (x1 > this._maxX) this._maxX = x1;
    if (y1 > this._maxY) this._maxY = y1;
  }

  /** Composites this frame's pixels onto `target`, which must be untransformed. */
  flush(target: CanvasRenderingContext2D): void {
    if (this._maxX < this._minX || this._image === null || this._ctx === null) return;

    const w = this._maxX - this._minX + 1;
    const h = this._maxY - this._minY + 1;
    this._ctx.putImageData(this._image, 0, 0, this._minX, this._minY, w, h);
    target.drawImage(
      this._canvas as CanvasImageSource,
      this._minX,
      this._minY,
      w,
      h,
      this._minX,
      this._minY,
      w,
      h,
    );
  }

  /**
   * Packs a CSS colour into one `Uint32`.
   *
   * `ImageData` is byte-ordered RGBA, so on a little-endian machine — which is
   * every platform a browser ships on — that reads back as `0xAABBGGRR`. The
   * canvas itself does the parsing, so any colour syntax it accepts works here.
   */
  private _pack(color: string): number {
    const cached = this._colors.get(color);
    if (cached !== undefined) {
      this._lastColor = color;
      this._lastPacked = cached;
      return cached;
    }

    if (this._probe === null) {
      const probe = document.createElement('canvas');
      probe.width = 1;
      probe.height = 1;
      this._probe = probe.getContext('2d', { willReadFrequently: true });
    }
    let packed = 0xff000000;
    if (this._probe !== null) {
      this._probe.clearRect(0, 0, 1, 1);
      this._probe.fillStyle = color;
      this._probe.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 255] = this._probe.getImageData(0, 0, 1, 1).data;
      packed = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    this._colors.set(color, packed);
    this._lastColor = color;
    this._lastPacked = packed;
    return packed;
  }

  private _growTouched(needed: number): void {
    let length = this._touched.length;
    while (length < needed) length *= 2;
    const grown = new Int32Array(length);
    grown.set(this._touched.subarray(0, this._touchedCount));
    this._touched = grown;
  }
}
