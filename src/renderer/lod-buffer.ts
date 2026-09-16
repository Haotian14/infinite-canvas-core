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
  #canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  #ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  #image: ImageData | null = null;
  #pixels: Uint32Array | null = null;
  #width = 0;
  #height = 0;

  /**
   * Indices written this frame, so clearing costs O(written) not O(viewport).
   * A preallocated typed array rather than `number[]`: at a hundred thousand
   * shapes a frame, `push` and its reallocations were the single hottest line
   * in the profile.
   */
  #touched = new Int32Array(4096);
  #touchedCount = 0;
  #minX = 0;
  #minY = 0;
  #maxX = 0;
  #maxY = 0;

  /** CSS colour string to a packed pixel, parsed once by the canvas itself. */
  #colors = new Map<string, number>();
  #probe: CanvasRenderingContext2D | null = null;
  /** Shapes arrive grouped by colour often enough that one slot pays for itself. */
  #lastColor = '';
  #lastPacked = 0;

  resize(deviceWidth: number, deviceHeight: number): void {
    if (deviceWidth === this.#width && deviceHeight === this.#height) return;
    this.#width = deviceWidth;
    this.#height = deviceHeight;

    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(deviceWidth, deviceHeight)
        : Object.assign(document.createElement('canvas'), {
            width: deviceWidth,
            height: deviceHeight,
          });
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    this.#image = this.#ctx.createImageData(deviceWidth, deviceHeight);
    this.#pixels = new Uint32Array(this.#image.data.buffer);
    this.#touchedCount = 0;
  }

  beginFrame(): void {
    const pixels = this.#pixels;
    if (pixels === null) return;

    // Past a quarter of the viewport, a bulk clear beats walking the list.
    if (this.#touchedCount > pixels.length / 4) {
      pixels.fill(0);
    } else {
      const touched = this.#touched;
      for (let i = 0; i < this.#touchedCount; i++) pixels[touched[i] as number] = 0;
    }

    this.#touchedCount = 0;
    this.#minX = this.#width;
    this.#minY = this.#height;
    this.#maxX = -1;
    this.#maxY = -1;
  }

  /** Paints a device-pixel box. `w`/`h` are clamped to at least one pixel. */
  plot(x: number, y: number, w: number, h: number, color: string): void {
    const pixels = this.#pixels;
    if (pixels === null) return;

    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.#width - 1, Math.floor(x + Math.max(w, 1)) - 1);
    const y1 = Math.min(this.#height - 1, Math.floor(y + Math.max(h, 1)) - 1);
    if (x1 < x0 || y1 < y0) return;

    const packed = color === this.#lastColor ? this.#lastPacked : this.#pack(color);
    const needed = this.#touchedCount + (x1 - x0 + 1) * (y1 - y0 + 1);
    if (needed > this.#touched.length) this.#growTouched(needed);
    const touched = this.#touched;
    let count = this.#touchedCount;

    if (x0 === x1 && y0 === y1) {
      // Overwhelmingly the common case once shapes are sub-pixel.
      const index = y0 * this.#width + x0;
      pixels[index] = packed;
      touched[count++] = index;
    } else {
      for (let py = y0; py <= y1; py++) {
        const row = py * this.#width;
        for (let px = x0; px <= x1; px++) {
          const index = row + px;
          pixels[index] = packed;
          touched[count++] = index;
        }
      }
    }
    this.#touchedCount = count;

    if (x0 < this.#minX) this.#minX = x0;
    if (y0 < this.#minY) this.#minY = y0;
    if (x1 > this.#maxX) this.#maxX = x1;
    if (y1 > this.#maxY) this.#maxY = y1;
  }

  /** Composites this frame's pixels onto `target`, which must be untransformed. */
  flush(target: CanvasRenderingContext2D): void {
    if (this.#maxX < this.#minX || this.#image === null || this.#ctx === null) return;

    const w = this.#maxX - this.#minX + 1;
    const h = this.#maxY - this.#minY + 1;
    this.#ctx.putImageData(this.#image, 0, 0, this.#minX, this.#minY, w, h);
    target.drawImage(
      this.#canvas as CanvasImageSource,
      this.#minX,
      this.#minY,
      w,
      h,
      this.#minX,
      this.#minY,
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
  #pack(color: string): number {
    const cached = this.#colors.get(color);
    if (cached !== undefined) {
      this.#lastColor = color;
      this.#lastPacked = cached;
      return cached;
    }

    if (this.#probe === null) {
      const probe = document.createElement('canvas');
      probe.width = 1;
      probe.height = 1;
      this.#probe = probe.getContext('2d', { willReadFrequently: true });
    }
    let packed = 0xff000000;
    if (this.#probe !== null) {
      this.#probe.clearRect(0, 0, 1, 1);
      this.#probe.fillStyle = color;
      this.#probe.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 255] = this.#probe.getImageData(0, 0, 1, 1).data;
      packed = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    this.#colors.set(color, packed);
    this.#lastColor = color;
    this.#lastPacked = packed;
    return packed;
  }

  #growTouched(needed: number): void {
    let length = this.#touched.length;
    while (length < needed) length *= 2;
    const grown = new Int32Array(length);
    grown.set(this.#touched.subarray(0, this.#touchedCount));
    this.#touched = grown;
  }
}
