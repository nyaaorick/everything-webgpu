/**
 * Isolates the three candidate costs behind slow decode:
 *   syncLatency  - cost of one submit + wait-for-GPU round trip (WebLLM does
 *                  exactly one per token)
 *   readback     - same, but ending in a 4-byte mapAsync, which is what
 *                  `sampleTokenFromLogits` actually does
 *   perDispatch  - marginal cost of each extra compute dispatch in one submit
 *
 * Run in both the hidden background page and a visible tab: a gap between the
 * two means Firefox is throttling the background document, which would be a
 * problem with where the engine lives, not with WebGPU itself.
 */
const WGSL = `
@group(0) @binding(0) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  data[gid.x] = data[gid.x] + 1u;
}`;

/**
 * Pure streaming read, to find the memory bandwidth actually reachable from a
 * WebGPU compute shader here.
 *
 * This is the calibration that decides where decode's missing performance lives.
 * Decode moves 420 MB of weights per token and measures ~16 GB/s against the
 * M4's ~120 GB/s peak. If a hand-written kernel doing nothing but reading gets
 * near peak, the generated dequant-GEMV kernels are the problem and are worth
 * fixing. If it does not, the platform is the ceiling and no kernel work helps.
 *
 * The `if` on the accumulator is never true; it exists so the loads cannot be
 * optimised away.
 */
const FILL_WGSL = `
@group(0) @binding(0) var<storage, read_write> dst: array<vec4<f32>>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(num_workgroups) nwg: vec3<u32>) {
  let stride = nwg.x * 256u;
  let n = arrayLength(&dst);
  var i = gid.x;
  loop {
    if (i >= n) { break; }
    dst[i] = vec4<f32>(f32(i), 1.0, 2.0, 3.0);
    i = i + stride;
  }
}`;

const STREAM_WGSL = `
@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> sink: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(num_workgroups) nwg: vec3<u32>) {
  let stride = nwg.x * 256u;
  let n = arrayLength(&src);
  var acc = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  var i = gid.x;
  loop {
    if (i >= n) { break; }
    acc = acc + src[i];
    i = i + stride;
  }
  let v = acc.x + acc.y + acc.z + acc.w;
  // Unconditional. A conditional store was enough for the compiler to delete
  // every load: the sweep then reported 1374 GB/s, well past what the hardware
  // can do, which is the tell that a bandwidth probe has been optimised away.
  sink[gid.x] = v;
}`;

/**
 * Same streaming read, parameterised by load width and workgroup size.
 *
 * The generated dequant-GEMV in the model reads packed weights as `array<u32>`,
 * one scalar 4-byte load per lane, from 64-thread workgroups. The probe above
 * uses 16-byte vec4 loads from 256-thread workgroups. If that difference alone
 * reproduces decode's ~16 GB/s, the fix is load width, not anything exotic.
 */
const streamVariant = (elem, wg, add) => `
@group(0) @binding(0) var<storage, read> src : array<${elem}>;
@group(0) @binding(1) var<storage, read_write> sink : array<f32>;
@compute @workgroup_size(${wg})
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
  let stride = nwg.x * ${wg}u;
  let n = arrayLength(&src);
  var acc = ${elem}(0);
  var i = gid.x;
  loop {
    if (i >= n) { break; }
    acc = acc + src[i];
    i = i + stride;
  }
  sink[gid.x] = ${add};
}`;

/**
 * The real kernel's inner loop, on the same buffer: load one packed u32, unpack
 * eight 4-bit weights, centre and scale each, accumulate. Nothing else — no
 * reduction, no scale traffic. Compared against a plain scalar read of the same
 * bytes, the difference is exactly what dequantisation costs.
 */
const DEQUANT_WGSL = (wg) => `
@group(0) @binding(0) var<storage, read> src : array<u32>;
@group(0) @binding(1) var<storage, read_write> sink : array<f32>;
@compute @workgroup_size(${wg})
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
  let stride = nwg.x * ${wg}u;
  let n = arrayLength(&src);
  let scale = 0.015625;
  var acc = 0.0;
  var i = gid.x;
  loop {
    if (i >= n) { break; }
    let w = src[i];
    acc = acc + (f32((w >> 0u) & 15u) - 7.0) * scale;
    acc = acc + (f32((w >> 4u) & 15u) - 7.0) * scale;
    acc = acc + (f32((w >> 8u) & 15u) - 7.0) * scale;
    acc = acc + (f32((w >> 12u) & 15u) - 7.0) * scale;
    acc = acc + (f32((w >> 16u) & 15u) - 7.0) * scale;
    acc = acc + (f32((w >> 20u) & 15u) - 7.0) * scale;
    acc = acc + (f32((w >> 24u) & 15u) - 7.0) * scale;
    acc = acc + (f32((w >> 28u) & 15u) - 7.0) * scale;
    i = i + stride;
  }
  sink[gid.x] = acc;
}`;

/**
 * The generated kernel's actual *shape*, not just its arithmetic.
 *
 * `fused_dequantize2_..._kernel` is `@workgroup_size(64)`, each thread runs a
 * 2-iteration loop, and the workgroup then reduces through `var<workgroup>
 * red_buf0` with barriers. That is a tiny amount of work per thread followed by
 * a synchronising tail — very different from a long streaming loop, and the last
 * candidate for the missing ~2.3x.
 */
const GEMV_SHAPE_WGSL = (iters) => `
@group(0) @binding(0) var<storage, read> src : array<u32>;
@group(0) @binding(1) var<storage, read_write> sink : array<f32>;
var<workgroup> red_buf0 : array<f32, 64>;
@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) bid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>,
        @builtin(local_invocation_id) tid : vec3<u32>) {
  let block = bid.z * nwg.x + bid.x;
  let n = arrayLength(&src);
  var acc = 0.0;
  for (var k = 0u; k < ${iters}u; k++) {
    let idx = (block * ${iters * 64}u) + (k * 64u) + tid.x;
    if (idx < n) {
      let w = src[idx];
      acc = acc + (f32((w >> 0u) & 15u) - 7.0) * 0.015625;
      acc = acc + (f32((w >> 4u) & 15u) - 7.0) * 0.015625;
      acc = acc + (f32((w >> 8u) & 15u) - 7.0) * 0.015625;
      acc = acc + (f32((w >> 12u) & 15u) - 7.0) * 0.015625;
      acc = acc + (f32((w >> 16u) & 15u) - 7.0) * 0.015625;
      acc = acc + (f32((w >> 20u) & 15u) - 7.0) * 0.015625;
      acc = acc + (f32((w >> 24u) & 15u) - 7.0) * 0.015625;
      acc = acc + (f32((w >> 28u) & 15u) - 7.0) * 0.015625;
    }
  }
  red_buf0[tid.x] = acc;
  workgroupBarrier();
  var stride = 32u;
  loop {
    if (stride == 0u) { break; }
    if (tid.x < stride) { red_buf0[tid.x] = red_buf0[tid.x] + red_buf0[tid.x + stride]; }
    workgroupBarrier();
    stride = stride >> 1u;
  }
  if (tid.x == 0u) { sink[block & 262143u] = red_buf0[0]; }
}`;

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const spread = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const at = (q) => +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(1);
  return `min=${at(0)} p50=${at(0.5)} p90=${at(0.9)} max=${+s[s.length - 1].toFixed(1)}`;
};

export async function gpuBench({ iters = 40 } = {}) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  // Default limits cap a storage binding at 128 MiB, which is too small to
  // out-run this chip's system cache: re-reading a 64 MB buffer measured a
  // marginal 123 GB/s, above the hardware's own peak. Ask for what the adapter
  // actually reports so the streaming test can use a buffer the size of a model.
  const want = (name, ceiling) => Math.min(adapter.limits[name] ?? 0, ceiling);
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: want("maxBufferSize", 768 * 1024 * 1024),
      maxStorageBufferBindingSize: want("maxStorageBufferBindingSize", 768 * 1024 * 1024),
    },
  });

  // Several probes below can kill the device (65536 dispatches in one pass did,
  // and 8192 compute passes in one encoder did). A lost device does not throw —
  // every later call quietly becomes a no-op and reports impossible numbers, so
  // track it and label the results rather than trusting them.
  let deviceLost = false;
  let phase = "startup";
  let lostDuring = null;
  device.lost.then(() => {
    deviceLost = true;
    lostDuring = lostDuring ?? phase;
  });

  // Bandwidth first, while the device is definitely healthy: it is the
  // calibration everything else is interpreted against.
  // ---- memory bandwidth ceiling ----------------------------------------
  // 64, not 128: `requestDevice()` without a descriptor grants *default* limits,
  // and maxStorageBufferBindingSize defaults to exactly 128 MiB regardless of
  // what the adapter advertises. Sitting on the boundary is how this probe
  // silently produced no-op dispatches.
  // 512 MB: bigger than any cache on this part, and close to the 420 MB of
  // weights decode actually streams per token.
  const STREAM_MB = Math.min(512, Math.floor(device.limits.maxStorageBufferBindingSize / 1024 / 1024));
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  const streamBytes = STREAM_MB * 1024 * 1024;
  const streamSrc = device.createBuffer({ size: streamBytes, usage: GPUBufferUsage.STORAGE });
  // One slot per thread (1024 workgroups x 256), so the store is never
  // out of bounds and cannot be discarded.
  const streamSink = device.createBuffer({ size: 1024 * 256 * 4, usage: GPUBufferUsage.STORAGE });
  const streamModule = device.createShaderModule({ code: STREAM_WGSL });
  const streamCompile = (await streamModule.getCompilationInfo?.())?.messages ?? [];
  const fillModule = device.createShaderModule({ code: FILL_WGSL });
  const fillCompile = (await fillModule.getCompilationInfo?.())?.messages ?? [];
  const shaderDiag = [...streamCompile, ...fillCompile]
    .filter((m) => m.type === "error")
    .map((m) => `${m.lineNum}:${m.linePos} ${m.message}`)
    .join(" | ");
  const streamPipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: streamModule, entryPoint: "main" },
  });
  // A buffer that has never been written can read back far too fast — the pages
  // are not committed yet, so the first attempt measured 17 TB/s. Fill it first.
  const fillPipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: fillModule, entryPoint: "main" },
  });
  {
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(fillPipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: fillPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: streamSrc } }],
      }),
    );
    pass.dispatchWorkgroups(1024);
    pass.end();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
  }

  const streamBind = device.createBindGroup({
    layout: streamPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: streamSrc } },
      { binding: 1, resource: { buffer: streamSink } },
    ],
  });

  /** n full passes over the buffer, all in one compute pass, one await. */
  async function timeStream(n, workgroups = 1024) {
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(streamPipeline);
    pass.setBindGroup(0, streamBind);
    for (let i = 0; i < n; i++) pass.dispatchWorkgroups(workgroups);
    pass.end();
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  }

  const streamOom = await device.popErrorScope();
  const streamValidation = await device.popErrorScope();
  const streamError = streamOom?.message ?? streamValidation?.message ?? null;

  await timeStream(8); // warm
  // Several points, so a shader that is silently doing nothing is obvious
  // instead of being reported as an implausible bandwidth.
  const streamPoints = [];
  for (const n of [8, 32, 96]) {
    const ms = await timeStream(n);
    streamPoints.push({ n, ms, gbs: +((n * streamBytes) / 1e9 / (ms / 1000)).toFixed(1) });
  }
  // Is 1024 workgroups the right amount of parallelism? Sweep it before
  // concluding anything about what the platform can do — an untuned kernel is
  // not evidence of a ceiling. 40 passes over 512 MB clears the tick ~20x.
  const occupancy = {};
  for (const wg of [256, 1024, 4096, 16384]) {
    const ms = await timeStream(40, wg);
    occupancy[`wg${wg}`] = `${((40 * streamBytes) / 1e9 / (ms / 1000)).toFixed(1)}GB/s`;
  }

  // Load width vs workgroup size, isolated. Same buffer, same total bytes.
  const widthProbe = {};
  for (const [label, elem, wg, add] of [
    ["vec4u32_wg256", "vec4<u32>", 256, "f32(acc.x + acc.y + acc.z + acc.w)"],
    ["vec4u32_wg64", "vec4<u32>", 64, "f32(acc.x + acc.y + acc.z + acc.w)"],
    ["scalar_u32_wg256", "u32", 256, "f32(acc)"],
    ["scalar_u32_wg64", "u32", 64, "f32(acc)"],
    ["dequant8_wg64", "__dequant64", 64, ""],
    ["dequant8_wg256", "__dequant256", 256, ""],
  ]) {
    const code = elem.startsWith("__dequant") ? DEQUANT_WGSL(wg) : streamVariant(elem, wg, add);
    const mod = device.createShaderModule({ code });
    // An invalid module does not throw: the pipeline just becomes a no-op and
    // the timing comes back as Infinity or a negative rate. Catch it here.
    const errs = ((await mod.getCompilationInfo?.())?.messages ?? []).filter((m) => m.type === "error");
    if (errs.length) {
      widthProbe[label] = `shader error: ${errs[0].message.slice(0, 80)}`;
      continue;
    }
    const pipe = device.createComputePipeline({
      layout: "auto",
      compute: { module: mod, entryPoint: "main" },
    });
    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: streamSrc } },
        { binding: 1, resource: { buffer: streamSink } },
      ],
    });
    const run = async (runs) => {
      const enc = device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bind);
      for (let i = 0; i < runs; i++) pass.dispatchWorkgroups(1024);
      pass.end();
      const t0 = performance.now();
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };
    await run(4); // warm
    // Two points: the marginal slope cancels the 100 ms tick. A single point at
    // 24 dispatches landed on 100 ms for every variant and "measured" 125 GB/s,
    // above what the memory can do — that is the grid, not the GPU.
    const msLo = await run(24);
    const msHi = await run(96);
    const gbs = ((96 - 24) * streamBytes) / 1e9 / ((msHi - msLo) / 1000);
    widthProbe[label] = `${gbs.toFixed(1)}GB/s`;
  }

  for (const iters of [2, 8, 32]) {
    const mod = device.createShaderModule({ code: GEMV_SHAPE_WGSL(iters) });
    const errs = ((await mod.getCompilationInfo?.())?.messages ?? []).filter((m) => m.type === "error");
    if (errs.length) {
      widthProbe[`gemvShape_x${iters}`] = `shader error: ${errs[0].message.slice(0, 80)}`;
    } else {
      const pipe = device.createComputePipeline({
        layout: "auto",
        compute: { module: mod, entryPoint: "main" },
      });
      const bind = device.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: streamSrc } },
          { binding: 1, resource: { buffer: streamSink } },
        ],
      });
      // Fewer workgroups as each does more, so total bytes stay comparable.
      const Z = Math.max(1, Math.round(8 * (2 / iters)));
      const X = 65535;
      const bytesPerRun = X * Z * 64 * iters * 4;
      const run = async (runs) => {
        const enc = device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(pipe);
        pass.setBindGroup(0, bind);
        for (let i = 0; i < runs; i++) pass.dispatchWorkgroups(X, 1, Z);
        pass.end();
        const t0 = performance.now();
        device.queue.submit([enc.finish()]);
        await device.queue.onSubmittedWorkDone();
        return performance.now() - t0;
      };
      await run(2);
      // Both points must clear the 100 ms tick, or the low one is rounded up to
      // it and the slope reports more bandwidth than the memory can deliver.
      const a = await run(24);
      const b = await run(96);
      const dt = b - a;
      widthProbe[`gemvShape_x${iters}`] =
        dt > 150
          ? `${(((96 - 24) * bytesPerRun) / 1e9 / (dt / 1000)).toFixed(1)}GB/s`
          : `inconclusive(dt=${dt.toFixed(0)}ms)`;
    }
  }

  const [lo, , hi] = streamPoints;
  const streamDelta = hi.ms - lo.ms;
  // If the slope is under a tick the grid, not the GPU, produced it.
  const streamGBs =
    streamDelta > 120 ? ((hi.n - lo.n) * streamBytes) / 1e9 / (streamDelta / 1000) : NaN;


  const buf = device.createBuffer({
    size: 4096,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const staging = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: "main" },
  });
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: buf } }],
  });

  function encode(dispatches) {
    const enc = device.createCommandEncoder();
    if (dispatches > 0) {
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      for (let i = 0; i < dispatches; i++) pass.dispatchWorkgroups(1);
      pass.end();
    }
    return enc;
  }

  async function timeSubmitSync(dispatches) {
    const samples = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      device.queue.submit([encode(dispatches).finish()]);
      await device.queue.onSubmittedWorkDone();
      samples.push(performance.now() - t0);
    }
    return median(samples);
  }

  async function timeReadback() {
    const samples = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      const enc = encode(1);
      enc.copyBufferToBuffer(buf, 0, staging, 0, 4);
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      staging.getMappedRange();
      staging.unmap();
      samples.push(performance.now() - t0);
    }
    return median(samples);
  }

  /** Await completion on an idle queue - nothing submitted, nothing to wait for. */
  let idleSpread = "";
  async function timeIdleSync() {
    const samples = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await device.queue.onSubmittedWorkDone();
      samples.push(performance.now() - t0);
    }
    idleSpread = spread(samples);
    return median(samples);
  }

  /**
   * CPU cost of encoding N kernel launches, the way tvmjs actually issues them.
   *
   * The `perDispatch` number above reuses one compute pass and one bind group
   * across every dispatch, which is not what the runtime does. Each TVM kernel
   * launch opens its own pass and builds a fresh bind group
   * (vendor/web-llm.js, `submitShader`):
   *
   *   beginComputePass -> setPipeline -> createBindGroup -> dispatch -> end
   *
   * `createBindGroup` is a validated, IPC-crossing allocation, so this is where
   * a real forward pass can spend its budget while a micro-benchmark that
   * rebinds nothing reports ~0. No `await` here on purpose: this measures
   * content-process CPU only, with GPU execution and the poll tick excluded.
   */
  function timeEncodeOnly(n, { freshBindGroup, freshPass }) {
    const t0 = performance.now();
    const enc = device.createCommandEncoder();
    let pass = freshPass ? null : enc.beginComputePass();
    if (pass) pass.setPipeline(pipeline);
    for (let i = 0; i < n; i++) {
      if (freshPass) {
        pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
      }
      pass.setBindGroup(
        0,
        freshBindGroup
          ? device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: [{ binding: 0, resource: { buffer: buf } }],
            })
          : bindGroup,
      );
      pass.dispatchWorkgroups(1);
      if (freshPass) pass.end();
    }
    if (!freshPass) pass.end();
    device.queue.submit([enc.finish()]);
    return performance.now() - t0;
  }

  /**
   * GPU cost of a compute *pass*, as opposed to a dispatch inside one.
   *
   * tvmjs opens a fresh `beginComputePass()` for every kernel launch, and WebGPU
   * puts a full barrier between passes — on Metal each pass becomes its own
   * command encoder. So "one pass, N dispatches" and "N passes, one dispatch"
   * are completely different costs even though both issue N dispatches, and only
   * the second matches what a real forward pass does.
   *
   * n must be large enough for the total to clear the 100 ms tick, or the poll
   * grid hides the whole effect.
   */
  async function timePasses(n, onePass) {
    const t0 = performance.now();
    const enc = device.createCommandEncoder();
    if (onePass) {
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      for (let i = 0; i < n; i++) pass.dispatchWorkgroups(1);
      pass.end();
    } else {
      for (let i = 0; i < n; i++) {
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
      }
    }
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  }

  /** N submits, one await: separates round-trip latency from per-submit throughput. */
  async function timePipelined(n) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) device.queue.submit([encode(1).finish()]);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - t0;
  }

  phase = "submit-sync";
  // Warm up: first submits pay one-off driver costs.
  await timeSubmitSync(1);

  const empty = await timeSubmitSync(0);
  const d1 = await timeSubmitSync(1);
  const d64 = await timeSubmitSync(64);
  const d256 = await timeSubmitSync(256);
  const readback = await timeReadback();
  /**
   * The poll drains *all* devices each tick, so N independent coroutines each
   * waiting on a sync should all wake on the same tick. If so the ceiling is
   * ~10 ticks/s shared, not ~10 syncs/s total, and concurrency buys real
   * throughput.
   */
  async function syncsPerSecond(concurrency, rounds = 15) {
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (let i = 0; i < rounds; i++) {
          device.queue.submit([encode(1).finish()]);
          await device.queue.onSubmittedWorkDone();
        }
      }),
    );
    return +((concurrency * rounds) / ((performance.now() - t0) / 1000)).toFixed(1);
  }

  const idle = await timeIdleSync();

  // Phase check: if the 100ms floor is a periodic poll rather than a fixed
  // delay, desynchronizing from it should halve the average wait.
  const desyncSamples = [];
  for (let i = 0; i < iters; i++) {
    await new Promise((r) => setTimeout(r, Math.random() * 100));
    const t0 = performance.now();
    device.queue.submit([encode(1).finish()]);
    await device.queue.onSubmittedWorkDone();
    desyncSamples.push(performance.now() - t0);
  }
  const desync = median(desyncSamples);
  const desyncMean = desyncSamples.reduce((a, b) => a + b, 0) / desyncSamples.length;
  const pipelined10 = await timePipelined(10);

  // Encode-only, 512 launches — roughly one real decode step's worth of kernels.
  const KERNELS = 512;
  await device.queue.onSubmittedWorkDone(); // settle before timing CPU
  const encodeReused = timeEncodeOnly(KERNELS, { freshBindGroup: false, freshPass: false });
  const encodeFreshBind = timeEncodeOnly(KERNELS, { freshBindGroup: true, freshPass: false });
  const encodeTvmStyle = timeEncodeOnly(KERNELS, { freshBindGroup: true, freshPass: true });
  await device.queue.onSubmittedWorkDone();

  // Pass-vs-dispatch, swept past the tick so the ramp is visible. A real decode
  // step issues ~660 kernels, i.e. ~660 passes.
  // Capped at 2048: 8192 passes in one encoder silently returns a bogus result
  // (measured the same 105 ms as a single pass) and leaves the device wedged, so
  // the page that ran it never finishes. 2048 is the largest point that both
  // clears the 100 ms tick and stays honest.
  // How much does a *dispatch inside a pass* actually cost? The pass sweep below
  // tops out at 2048, whose one-pass time equals the 100 ms tick — which only
  // bounds per-dispatch at <=51 us, it does not show it is free. Push the count
  // until the total has to clear the tick, so the two possible worlds separate:
  // at ~46 us/dispatch 65536 would take ~3 s; at ~1 us it stays inside one tick.
  phase = "dispatch-sweep";
  const dispatchSweep = {};
  for (const n of [2048, 8192, 16384]) {
    const ms = await timePasses(n, true);
    dispatchSweep[`dispatch${n}InOnePassMs`] = +ms.toFixed(0);
    dispatchSweep[`dispatch${n}UsEach`] = +((ms / n) * 1000).toFixed(2);
  }

  // ---- pass sweep, on a device of its own --------------------------------
  //
  // This is the probe that kills the device: 2048 compute passes in one encoder
  // loses it outright, and a lost device does not throw — every later call
  // quietly no-ops. Two things followed from sharing the main device with it.
  //
  // The first was that everything after this point was suspect. That turned out
  // to be nothing, because the sweep was already last — but "trustworthy only
  // because nothing runs after it" is a property that breaks the moment someone
  // adds a probe below.
  //
  // The second is the real one: the sweep corrupts *its own* numbers. The run
  // that prompted this reported `perPass=-3.9us` — 512 passes measured faster
  // than one, i.e. negative time per pass, which is the device dying mid-sweep
  // and the remaining submits becoming free.
  //
  // A sacrificial device was the first fix, and it half worked: the sweep's own
  // numbers became honest (`n512` went from `perPass=-3.9us` to ~10us, `n2048`
  // said `discarded`), but the *main* device still died. A runaway command
  // buffer on Metal resets the whole adapter, not one device on it, so
  // isolation bought trustworthy numbers and no containment at all.
  //
  // The second fix removes the cause rather than the blast radius. **The limit
  // is passes per encoder, not passes per measurement**: 512 in one encoder is
  // proven fine, 2048 is not. So the passes are split across encoders of at
  // most 512 and handed to a *single* `queue.submit([...])`.
  //
  // What makes that still a valid measurement is that both arms are chunked
  // identically — same encoder count, same submit count, same total passes —
  // so the difference between them remains pure per-pass overhead, which is the
  // only quantity this probe exists to produce.
  //
  // The sacrificial device stays. It is nearly free, and if a future driver
  // dies somewhere else in here it should not take the run's other numbers.
  phase = "pass-sweep";
  const passSweep = {};
  let sweepDeviceLost = false;
  try {
    const sweepDevice = await adapter.requestDevice();
    sweepDevice.lost.then(() => (sweepDeviceLost = true));
    const sweepBuf = sweepDevice.createBuffer({
      size: 4096,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const sweepPipeline = sweepDevice.createComputePipeline({
      layout: "auto",
      compute: { module: sweepDevice.createShaderModule({ code: WGSL }), entryPoint: "main" },
    });
    const sweepBind = sweepDevice.createBindGroup({
      layout: sweepPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: sweepBuf } }],
    });

    /**
     * Passes per *encoder*. 512 completes cleanly on this driver; 2048 in one
     * encoder is what loses the device. Both arms use the same chunking, so the
     * split cancels out of the difference between them.
     */
    const MAX_PASSES_PER_ENCODER = 512;

    const sweepPasses = async (n, onePass) => {
      const chunks = Math.ceil(n / MAX_PASSES_PER_ENCODER);
      const t0 = performance.now();
      const buffers = [];
      let remaining = n;
      for (let c = 0; c < chunks; c++) {
        const count = Math.min(MAX_PASSES_PER_ENCODER, remaining);
        remaining -= count;
        const enc = sweepDevice.createCommandEncoder();
        if (onePass) {
          const pass = enc.beginComputePass();
          pass.setPipeline(sweepPipeline);
          pass.setBindGroup(0, sweepBind);
          for (let i = 0; i < count; i++) pass.dispatchWorkgroups(1);
          pass.end();
        } else {
          for (let i = 0; i < count; i++) {
            const pass = enc.beginComputePass();
            pass.setPipeline(sweepPipeline);
            pass.setBindGroup(0, sweepBind);
            pass.dispatchWorkgroups(1);
            pass.end();
          }
        }
        buffers.push(enc.finish());
      }
      // One submit regardless of how many encoders it took, so submit overhead
      // is identical across arms and across values of n.
      sweepDevice.queue.submit(buffers);
      await sweepDevice.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };

    for (const n of [512, 2048]) {
      if (sweepDeviceLost) {
        passSweep[`n${n}`] = "skipped (sweep device already lost)";
        continue;
      }
      const inOnePass = await sweepPasses(n, true);
      const inNPasses = await sweepPasses(n, false);
      const perPass = ((inNPasses - inOnePass) / n) * 1000;
      // A negative per-pass cost is not a fast GPU, it is a dead one. Report the
      // fact rather than a number that will be read as a measurement.
      passSweep[`n${n}`] = sweepDeviceLost
        ? `discarded (device lost during the ${n}-pass encode)`
        : perPass < 0
          ? `discarded (perPass=${perPass.toFixed(1)}us — negative, device likely lost)`
          : `1pass=${inOnePass.toFixed(0)}ms ${n}passes=${inNPasses.toFixed(0)}ms ` +
            `perPass=${perPass.toFixed(1)}us` +
            // Named, because "2048 passes" now means 4 encoders rather than 1 and
            // a reader comparing against an older run should see why.
            (n > MAX_PASSES_PER_ENCODER ? ` (${Math.ceil(n / MAX_PASSES_PER_ENCODER)} encoders, 1 submit)` : "");
    }
    if (!sweepDeviceLost) sweepDevice.destroy();
  } catch (err) {
    passSweep.n512 = `unavailable: ${String(err?.message ?? err).slice(0, 120)}`;
  }

  device.destroy();
  return {
    idleSyncMs: +idle.toFixed(3),
    idleSyncSpread: idleSpread,
    syncsPerSec_1: await syncsPerSecond(1),
    syncsPerSec_4: await syncsPerSecond(4),
    syncsPerSec_16: await syncsPerSecond(16),
    syncAfterRandomDelayMs: +desync.toFixed(1),
    syncAfterRandomDelayMean: +desyncMean.toFixed(1),
    syncAfterRandomDelaySpread: spread(desyncSamples),
    pipelined10SubmitsMs: +pipelined10.toFixed(3),
    emptySubmitSyncMs: +empty.toFixed(3),
    dispatch1Ms: +d1.toFixed(3),
    dispatch64Ms: +d64.toFixed(3),
    dispatch256Ms: +d256.toFixed(3),
    perDispatchMs: +((d256 - d1) / 255).toFixed(4),
    readback4BytesMs: +readback.toFixed(3),
    // CPU-only encode cost per kernel launch, in microseconds. `tvmStyle` is the
    // pattern the runtime really uses; `reused` is what `perDispatchMs` above
    // measures. A large gap means decode is bound by command encoding, not by
    // the GPU and not by the poll tick.
    encodeReusedUsPerKernel: +((encodeReused / KERNELS) * 1000).toFixed(2),
    encodeFreshBindGroupUsPerKernel: +((encodeFreshBind / KERNELS) * 1000).toFixed(2),
    encodeTvmStyleUsPerKernel: +((encodeTvmStyle / KERNELS) * 1000).toFixed(2),
    encodeTvmStyle512KernelsMs: +encodeTvmStyle.toFixed(2),
    // GPU-side cost of one compute pass, which is what tvmjs spends per kernel.
    ...passSweep,
    // Cost of a dispatch *inside* a pass, swept past the tick so it is a real
    // measurement rather than an upper bound imposed by the poll grid.
    ...dispatchSweep,
    // The main device. The pass-sweep now runs on its own, so this no longer
    // reports "yes, during pass-sweep" for a loss that was expected and
    // contained — a loss here means a probe that was supposed to be safe wasn't.
    deviceLostDuringBench: deviceLost ? `yes, during ${lostDuring}` : false,
    passSweepDeviceLost: sweepDeviceLost,
    streamBufferMB: STREAM_MB,
    streamByLoadWidth: Object.entries(widthProbe).map(([k, v]) => `${k}=${v}`).join(" "),
    streamByWorkgroups: Object.entries(occupancy).map(([k, v]) => `${k}=${v}`).join(" "),
    streamReadGBs: streamError
      ? `failed: ${(shaderDiag || streamError).slice(0, 200)}`
      : Number.isNaN(streamGBs)
        ? "inconclusive (slope under one tick)"
        : +streamGBs.toFixed(1),
    streamReadDetail: streamPoints
      .map((p) => `x${p.n}=${p.ms.toFixed(0)}ms(${p.gbs}GB/s)`)
      .join(" "),
  };
}
