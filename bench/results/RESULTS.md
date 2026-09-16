# Benchmark results

Generated 2026-09-16T07:04:20.105Z · 180 measured frames after 30 warmup
frames, 3 repetitions per scenario, **median run reported**.

`run spread` is the gap between the fastest and slowest repetition. Treat any
difference smaller than that as noise — on a shared or throttled machine it
routinely exceeds 20%, which is larger than most changes worth measuring.

**Machine** — Intel(R) Xeon(R) Processor @ 2.10GHz, 4 cores, 15.7 GB · Linux 6.18.44-fc-v33
**Browser** — Chromium 141.0.7390.37, headless=true, GPU: `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`
**Viewport** — 1600x900 @ dpr 1

> `render` is the engine's own cost — cull query plus draw calls, measured inside
> `Canvas2DRenderer.render`. It is the number the engine controls, so it is the one
> tracked for regressions; rAF cadence is capped by the display and says more about
> the browser than about this code.
> A software-rasterised headless run is a **lower bound** — expect better on real hardware.

## Frame cost

| scenario | nodes | drawn/frame | render p50 (ms) | p95 | p99 | % of 16.7 ms budget (p95) | run spread |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `pan-close` | 100,000 | 584 | 0.20 | 0.30 | 0.40 | 2% ✅ | ±0% |
| `pan-mid` | 100,000 | 5,707 | 1.90 | 2.30 | 2.80 | 14% ✅ | ±16% |
| `zoom-cycle` | 100,000 | 13,922 | 0.70 | 19.60 | 21.40 | 118% ⚠️ | ±14% |
| `overview` | 100,000 | 97,619 | 13.80 | 17.50 | 18.80 | 105% ⚠️ | ±14% |
| `overview` *(no LOD)* | 100,000 | 97,619 | 35.40 | 39.70 | 42.90 | 238% ⚠️ | ±3% |
| `overview` *(no LOD, no batching)* | 100,000 | 97,619 | 49.20 | 53.40 | 69.60 | 320% ⚠️ | ±1% |
| `pan-mid` | 10,000 | 580 | 0.20 | 0.30 | 0.30 | 2% ✅ | ±0% |

| name | what it measures |
| --- | --- |
| `pan-close` | ~1% of the world visible. The common editing case: culling should do nearly all the work. |
| `pan-mid` | ~10% of the world visible. |
| `zoom-cycle` | Continuous zoom between overview and close, i.e. a cull set that changes every frame. |
| `overview` | The whole scene on screen. Worst case: culling rejects nothing. |

## Viewport queries

Cull query only, no drawing: how long it takes to find what is on screen.

| nodes | hits/query | indexed (µs) | linear scan (µs) | speedup |
| --- | ---: | ---: | ---: | ---: |
| 10,000 | 107 | 3.5 | 43.6 | **12.5x** |
| 100,000 | 1,027 | 39.5 | 588.5 | **14.9x** |

## Where the worst case went

Zoomed all the way out, culling rejects nothing: all 97,619 nodes are on
screen, each about a pixel across. Two changes carried it into frame budget.

| overview @ 100,000 | render p50 (ms) | p95 (ms) | vs baseline |
| --- | ---: | ---: | ---: |
| one `fillRect` per node | 49.2 | 53.4 | — |
| + one path per fill colour | 35.4 | 39.7 | 1.39x |
| + sub-pixel LOD | **13.8** | **17.5** | **3.57x** |

The profile said the frame was not pixel-bound: `ctx.rect()` alone was around a
third of it. A hundred thousand of anything through the canvas API costs a
hundred thousand JS-to-C++ crossings, and batching them into one path per colour
removes the `fill` calls but not the `rect` calls — which is why it moves less
than it looks like it should.

Below about a pixel a rectangle's geometry is not resolvable anyway, so those
shapes are written directly into an `ImageData` — a few typed-array stores each —
and uploaded as one region. Trade-offs: sub-pixel shapes lose antialiasing and
exact z-order, and a single path cannot express per-node paint order, so
batching is only valid while same-coloured shapes are interchangeable.

Note the run spread column before reading much into the middle row.

## Reproducing

```bash
pnpm install
pnpm bench          # add --stress for the 1M-node run, --headed to watch
```

Flame charts land in `bench/results/*.cpuprofile`. Open Chrome DevTools →
Performance → *Load profile*, or drop the file into https://speedscope.app.
