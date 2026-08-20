/**
 * Engine pool + priority scheduler.
 *
 * Why this exists: the GPU gives us ~10 completion ticks per second, shared by
 * every caller (README, "The 10 tok/s ceiling"). Two consequences drive the
 * whole design:
 *
 *  - A single generation can never beat ~10 tok/s, but N concurrent ones each
 *    get ~10 tok/s because they all wake on the same tick. Measured linear to
 *    16x. So independent work must be fanned out, not serialized.
 *  - Every engine in the pool holds its own copy of the weights, so the pool is
 *    small and its slots are the scarce resource worth scheduling.
 *
 * The scheduler is therefore three mechanisms and no more:
 *  1. Priority bands, FIFO within a band.
 *  2. Session supersession - a new job with the same `session` cancels the
 *     previous one. This is the ghost-text primitive: every keystroke replaces
 *     the last request instead of queueing behind it.
 *  3. Opt-in preemption - an `interactive` job with no free slot may interrupt
 *     a running job that declared `preemptible`. The victim resolves with what
 *     it produced so far, so it is never requeued and can never starve.
 *
 * `createEngine` is injected so the scheduler can be tested without a GPU.
 */
import { PRIORITY, PRIORITY_ORDER } from "../lib/protocol.js";

/** Engines built simultaneously. See `load()` for why this is not unbounded. */
const LOAD_CONCURRENCY = 2;

let nextJobId = 0;

export class EnginePool {
  #size;
  #createEngine;
  #onStateChange;
  #slots = [];
  #queues = new Map(PRIORITY_ORDER.map((p) => [p, []]));
  #bySession = new Map();
  #loading = null;

  constructor({ size = 2, createEngine, onStateChange = () => {} }) {
    this.#size = Math.max(1, Math.min(4, size));
    this.#createEngine = createEngine;
    this.#onStateChange = onStateChange;
  }

  get size() {
    return this.#size;
  }

  get loaded() {
    return this.#slots.length > 0;
  }

  /**
   * Builds every engine, at most LOAD_CONCURRENCY at a time.
   *
   * Loads overlap almost perfectly (most of the time goes to shader
   * compilation, which parallelizes), so doing them all at once is tempting.
   * But each load also stages the full weight set in host memory before handing
   * it to the GPU, and steady state is already ~1.6 GB per engine — measured on
   * a 16 GB machine, four engines leave ~0.4 GB free. Adding four simultaneous
   * staging buffers on top is what tips it into swapping.
   *
   * Two at a time keeps the common pool size loading at full speed while
   * bounding the transient cost for larger pools.
   */
  async load(onProgress = () => {}) {
    if (this.#loading) return this.#loading;

    const progress = new Array(this.#size).fill(0);
    const report = (i, report_) => {
      progress[i] = report_.progress ?? 0;
      onProgress({
        text: this.#size === 1 ? report_.text : `engine ${i + 1}/${this.#size}: ${report_.text}`,
        progress: progress.reduce((a, b) => a + b, 0) / this.#size,
      });
    };

    this.#loading = (async () => {
      const engines = [];
      for (let i = 0; i < this.#size; i += LOAD_CONCURRENCY) {
        const wave = Array.from(
          { length: Math.min(LOAD_CONCURRENCY, this.#size - i) },
          (_, k) => this.#createEngine(i + k, (r) => report(i + k, r)),
        );
        engines.push(...(await Promise.all(wave)));
      }
      this.#slots = engines.map((engine) => ({ engine, job: null }));
      return this.#slots.length;
    })().finally(() => {
      this.#loading = null;
    });

    return this.#loading;
  }

  async unload() {
    for (const job of this.#allJobs()) this.#finish(job, { cancelled: true });
    for (const p of this.#queues.values()) p.length = 0;
    this.#bySession.clear();
    const slots = this.#slots;
    this.#slots = [];
    await Promise.all(slots.map((s) => s.engine.unload?.().catch(() => {})));
  }

  /**
   * @param {object} spec
   * @param {object} spec.params  passed straight to `engine.chat.completions.create`
   * @param {string} [spec.session] later jobs with this session supersede earlier ones
   * @param {string} [spec.priority] one of PRIORITY
   * @param {boolean} [spec.preemptible] may be interrupted by an interactive job
   * @param {(delta: string) => void} [spec.onChunk]
   * @returns {Promise<{text: string, usage?: object, cancelled?: boolean, preempted?: boolean}>}
   */
  submit(spec) {
    const priority = PRIORITY_ORDER.includes(spec.priority) ? spec.priority : PRIORITY.NORMAL;
    const job = {
      id: spec.id ?? `job-${++nextJobId}`,
      session: spec.session,
      priority,
      preemptible: Boolean(spec.preemptible),
      params: spec.params,
      onChunk: spec.onChunk ?? (() => {}),
      text: "",
      slot: null,
      done: false,
    };
    job.promise = new Promise((resolve) => (job.resolve = resolve));

    if (job.session) {
      const previous = this.#bySession.get(job.session);
      // Superseded, not queued behind: the keystroke that produced the old
      // request is already stale.
      if (previous) this.cancel(previous.id);
      this.#bySession.set(job.session, job);
    }

    this.#queues.get(priority).push(job);
    this.#pump();
    this.#emit();
    return job.promise;
  }

  /** Cancels by job id or by session key. Returns how many jobs it stopped. */
  cancel(idOrSession) {
    let stopped = 0;
    for (const job of this.#allJobs()) {
      if (job.id !== idOrSession && job.session !== idOrSession) continue;
      stopped += 1;
      if (job.slot === null) {
        this.#dequeue(job);
        this.#finish(job, { cancelled: true });
      } else {
        job.cancelling = true;
        this.#slots[job.slot].engine.interruptGenerate();
      }
    }
    if (stopped) this.#emit();
    return stopped;
  }

  /**
   * Pushes a runtime setting to every engine that accepts one.
   *
   * Separate from `load()` because the settings this carries — `decodeSteps` so
   * far — are per-generation knobs, not per-model ones: retuning them must not
   * cost a reload of the weights.
   */
  configure(patch) {
    let applied = 0;
    for (const slot of this.#slots) {
      if (typeof slot.engine.configure !== "function") continue;
      slot.engine.configure(patch);
      applied += 1;
    }
    return applied;
  }

  status() {
    return {
      size: this.#size,
      busy: this.#slots.filter((s) => s.job !== null).length,
      queued: PRIORITY_ORDER.reduce((n, p) => n + this.#queues.get(p).length, 0),
      queuedByPriority: Object.fromEntries(
        PRIORITY_ORDER.map((p) => [p, this.#queues.get(p).length]),
      ),
    };
  }

  // ------------------------------------------------------------ internals ---

  *#allJobs() {
    for (const slot of this.#slots) if (slot.job) yield slot.job;
    for (const p of PRIORITY_ORDER) yield* this.#queues.get(p);
  }

  #dequeue(job) {
    const queue = this.#queues.get(job.priority);
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
  }

  #nextJob() {
    for (const p of PRIORITY_ORDER) {
      const queue = this.#queues.get(p);
      if (queue.length) return queue[0];
    }
    return null;
  }

  #pump() {
    for (;;) {
      const job = this.#nextJob();
      if (!job) return;

      const slot = this.#slots.findIndex((s) => s.job === null);
      if (slot >= 0) {
        this.#dequeue(job);
        this.#start(slot, job);
        continue;
      }

      // No slot. Only an interactive job is allowed to take one by force, and
      // only from a job that opted in.
      if (job.priority !== PRIORITY.INTERACTIVE) return;
      const victim = this.#slots.find((s) => s.job?.preemptible && !s.job.cancelling);
      if (!victim) return;
      victim.job.preempting = true;
      victim.job.cancelling = true;
      victim.engine.interruptGenerate();
      return; // the freed slot re-enters #pump when the victim settles
    }
  }

  #start(slotIndex, job) {
    const slot = this.#slots[slotIndex];
    slot.job = job;
    job.slot = slotIndex;
    job.startedAt = performance.now();
    job.engineIndex = slotIndex;
    this.#emit();

    (async () => {
      try {
        const stream = await slot.engine.chat.completions.create({
          ...job.params,
          stream: true,
          stream_options: { include_usage: true },
        });
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            job.text += delta;
            job.onChunk(delta);
          }
          if (chunk.usage) job.usage = chunk.usage;
        }
        this.#finish(job, {
          cancelled: Boolean(job.cancelling && !job.preempting),
          preempted: Boolean(job.preempting),
        });
      } catch (err) {
        this.#finish(job, { error: String(err?.message ?? err) });
      } finally {
        slot.job = null;
        job.slot = null;
        this.#pump();
        this.#emit();
      }
    })();
  }

  #finish(job, extra) {
    if (job.done) return;
    job.done = true;
    if (this.#bySession.get(job.session) === job) this.#bySession.delete(job.session);
    job.resolve({
      id: job.id,
      text: job.text,
      usage: job.usage,
      engineIndex: job.engineIndex,
      startedAt: job.startedAt,
      finishedAt: performance.now(),
      ...extra,
    });
  }

  #emit() {
    this.#onStateChange(this.status());
  }
}
