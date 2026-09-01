/**
 * Engine pool + priority scheduler.
 *
 * Why this exists: the GPU gives us ~10 completion ticks per second, shared by
 * every caller (README, "The 10 tok/s ceiling"). Two consequences drive the
 * whole design:
 *
 *  - A single generation can never beat ~10 tok/s. When decode is *sync-bound*
 *    - waiting on the ~100 ms tick rather than on the GPU - N concurrent ones
 *    each still get ~10 tok/s, because they all wake on the same tick. That
 *    held for the 0.8B (1.3-2.0x on two engines) and stops holding once the
 *    model is big enough to keep the GPU busy: measured 1.06x on the 2B, where
 *    two streams simply run at half speed each. Fan-out is worth having, but
 *    the second engine earns its memory through isolation, not throughput.
 *  - Every engine in the pool holds its own copy of the weights, so the pool is
 *    small and its slots are the scarce resource worth scheduling.
 *
 * The scheduler is therefore four mechanisms and no more:
 *  1. Priority bands, FIFO within a band.
 *  2. Session supersession - a new job with the same `session` cancels the
 *     previous one. This is the ghost-text primitive: every keystroke replaces
 *     the last request instead of queueing behind it.
 *  3. Opt-in preemption - an `interactive` job with no free slot may interrupt
 *     a running job that declared `preemptible`. The victim resolves with what
 *     it produced so far, so it is never requeued and can never starve.
 *  4. Demand-driven growth - the pool starts at one engine and earns another
 *     only when a *different* task is waiting on a busy pool. See `#grow`.
 *
 * Jobs carry a `task`: the unit that owns an engine. Every item of one batch
 * shares it, so "translate this page" is one task however many requests it is.
 * Slots are handed out per job, but the last free slot is reserved per task -
 * otherwise one batch fills the pool and ghost-text starves behind it.
 *
 * `createEngine` is injected so the scheduler can be tested without a GPU.
 */
import { PRIORITY, PRIORITY_ORDER } from "./constants.js";

let nextJobId = 0;

export class EnginePool {
  #maxSize;
  #createEngine;
  #onStateChange;
  #slots = [];
  #queues = new Map(PRIORITY_ORDER.map((p) => [p, []]));
  #bySession = new Map();
  #loading = null;
  #growing = null;
  /** Set to the failure reason once a grow attempt fails; growth then stops. */
  #growthBlocked = null;
  /**
   * Bumped by `unload()`. An engine that finishes loading against a stale
   * generation is torn down rather than installed — see `load()`.
   */
  #generation = 0;

  constructor({ size = 2, createEngine, onStateChange = () => {} }) {
    this.#maxSize = Math.max(1, Math.min(4, size));
    this.#createEngine = createEngine;
    this.#onStateChange = onStateChange;
  }

  /** Engines that exist right now, which is not the same as the cap. */
  get size() {
    return this.#slots.length;
  }

  get maxSize() {
    return this.#maxSize;
  }

  get loaded() {
    return this.#slots.length > 0;
  }

  /**
   * Brings up the first engine, and only the first.
   *
   * The pool used to build every engine here. It no longer does, because an
   * engine is a full copy of the weights - measured ~1.6 GB steady state for
   * the 0.8B, ~2.4 GB for a 2B - and staging a second one costs that much host
   * memory before the GPU ever sees it. On a 16 GB machine that is the
   * difference between working and swapping, and it was being paid up front
   * whether or not two tasks ever ran at once. `#grow` earns the rest.
   */
  async load(onProgress = () => {}) {
    if (this.#loading) return this.#loading;

    const generation = this.#generation;
    this.#loading = (async () => {
      const engine = await this.#createEngine(0, (report) =>
        onProgress({ ...report, engine: 1, engines: 1 }),
      );
      // `unload()` may have run while this was still building — a cancelled
      // load, or a model switch. Installing it now would resurrect an engine
      // nobody holds a reference to, leaking its worker and a full copy of the
      // weights. `#grow()` has always guarded this; `load()` did not.
      if (generation !== this.#generation) {
        await engine.unload?.().catch(() => {});
        return 0;
      }
      this.#slots = [{ engine, job: null }];
      return this.#slots.length;
    })().finally(() => {
      this.#loading = null;
    });

    return this.#loading;
  }

  async unload() {
    this.#generation += 1;
    for (const job of this.#allJobs()) this.#finish(job, { cancelled: true });
    for (const p of this.#queues.values()) p.length = 0;
    this.#bySession.clear();
    // A smaller model may well fit where this one did not.
    this.#growthBlocked = null;
    const slots = this.#slots;
    this.#slots = [];
    await Promise.all(slots.map((s) => s.engine.unload?.().catch(() => {})));
  }

  /**
   * @param {object} spec
   * @param {object} spec.params  passed straight to `engine.chat.completions.create`
   * @param {string} [spec.task] the unit that owns an engine; a whole batch shares one
   * @param {string} [spec.session] later jobs with this session supersede earlier ones
   * @param {string} [spec.priority] one of PRIORITY
   * @param {boolean} [spec.preemptible] may be interrupted by an interactive job
   * @param {(chunk: object) => void} [spec.onChunk] WebLLM's chunk, verbatim
   * @returns {Promise<{text: string, usage?: object, cancelled?: boolean, preempted?: boolean}>}
   */
  submit(spec) {
    const priority = PRIORITY_ORDER.includes(spec.priority) ? spec.priority : PRIORITY.NORMAL;
    const id = spec.id ?? `job-${++nextJobId}`;
    const job = {
      id,
      // Unlabelled work is its own task, so two bare `chat` calls still compete
      // for separate engines the way two different callers would.
      task: spec.task ?? spec.session ?? id,
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
      size: this.#slots.length,
      maxSize: this.#maxSize,
      growing: this.#growing !== null,
      // Non-null once a second engine failed to come up; the UI can say why the
      // pool is smaller than the cap instead of looking stuck.
      growthBlocked: this.#growthBlocked,
      busy: this.#slots.filter((s) => s.job !== null).length,
      queued: PRIORITY_ORDER.reduce((n, p) => n + this.#queues.get(p).length, 0),
      queuedByPriority: Object.fromEntries(
        PRIORITY_ORDER.map((p) => [p, this.#queues.get(p).length]),
      ),
    };
  }

  // ------------------------------------------------------------ internals ---

  /**
   * Adds one engine, but only when a second one would actually buy something.
   *
   * There is no budget to check against: Firefox implements neither
   * `navigator.deviceMemory` nor `performance.memory`, and `storage.estimate()`
   * measures disk quota, not RAM. Nothing reports free memory to an extension.
   *
   * So the pool does not predict, it probes - and it only probes when the
   * answer matters. A failed load is taken as the answer and is not retried:
   * the retry would cost another full staging pass to learn the same thing.
   */
  #grow() {
    if (this.#growing || this.#growthBlocked || this.#loading) return;
    if (this.#slots.length >= this.#maxSize) return;
    if (!this.#crossTaskDemand()) return;

    const index = this.#slots.length;
    this.#growing = (async () => {
      try {
        const engine = await this.#createEngine(index, () => {});
        // `unload()` may have emptied the pool while this was still loading;
        // pushing then would resurrect a slot for a model nobody asked for.
        if (this.#slots.length === index) this.#slots.push({ engine, job: null });
        else await engine.unload?.().catch(() => {});
      } catch (err) {
        // Almost always memory. Staying at the current size is the right
        // outcome, not an error owed to whichever job happened to trigger it.
        this.#growthBlocked = err?.message ?? String(err);
      }
    })().finally(() => {
      this.#growing = null;
      this.#pump();
      this.#emit();
    });
  }

  /**
   * True when a queued job belongs to a task that is not already running.
   *
   * This is the entire growth policy. A second engine exists so that a
   * translation and a ghost-text completion can run at once - not to make one
   * batch finish sooner. Four queued items of the same batch keep the pool at
   * one engine; one queued completion alongside them grows it.
   */
  #crossTaskDemand() {
    const running = this.#runningTasks();
    if (running.size === 0) return false;
    for (const job of this.#queued()) if (!running.has(job.task)) return true;
    return false;
  }

  #runningTasks() {
    const tasks = new Set();
    for (const slot of this.#slots) if (slot.job) tasks.add(slot.job.task);
    return tasks;
  }

  *#queued() {
    for (const p of PRIORITY_ORDER) yield* this.#queues.get(p);
  }

  *#allJobs() {
    for (const slot of this.#slots) if (slot.job) yield slot.job;
    yield* this.#queued();
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
      const slot = this.#slots.findIndex((s) => s.job === null);
      const job = slot >= 0 ? this.#pick() : this.#nextJob();
      if (!job) break;

      if (slot >= 0) {
        this.#dequeue(job);
        this.#start(slot, job);
        continue;
      }

      // No slot. Only an interactive job is allowed to take one by force, and
      // only from a job that opted in.
      if (job.priority !== PRIORITY.INTERACTIVE) break;
      const victim = this.#slots.find((s) => s.job?.preemptible && !s.job.cancelling);
      if (!victim) break;
      victim.job.preempting = true;
      victim.job.cancelling = true;
      victim.engine.interruptGenerate();
      break; // the freed slot re-enters #pump when the victim settles
    }
    this.#grow();
  }

  /**
   * Which queued job takes a free slot: the first, by priority, whose task is
   * not already running.
   *
   * **One task holds at most one engine.** Letting a batch spread over the pool
   * used to be the point - it was worth 1.3-2.0x on the 0.8B, where decode was
   * sync-bound and a second stream filled idle GPU. On the 2B it is worth
   * 1.06x: the GPU is busy, so two streams of the same work just run at half
   * speed each (measured; `engine scaling:` in the e2e). That buys nothing, and
   * it costs the thing a second engine is actually for - a page translation
   * would sit on both engines and ghost-text would wait behind it.
   *
   * So the rule is flat, and two runnable tasks are therefore always running at
   * once whenever two engines exist. An engine may idle while one task has work
   * queued; that is the ~6% being deliberately given up.
   *
   * `interactive` is the one exception: that band exists for work a human is
   * waiting on keystroke-by-keystroke, and it takes a free engine regardless.
   */
  #pick() {
    const head = this.#nextJob();
    if (!head || head.priority === PRIORITY.INTERACTIVE) return head;

    const running = this.#runningTasks();
    for (const job of this.#queued()) if (!running.has(job.task)) return job;
    return null;
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
          const choice = chunk.choices?.[0];
          job.text += choice?.delta?.content ?? "";
          // WebLLM's own "stop" | "length" | "abort" | "tool_calls". Kept
          // because a caller cannot otherwise tell a natural stop from a
          // `max_tokens` truncation.
          if (choice?.finish_reason) job.finishReason = choice.finish_reason;
          // Assigned, not merged: WebLLM parses the whole output message at the
          // end and emits tool calls complete in one terminal chunk. It never
          // streams the OpenAI-style fragments, so there is nothing to
          // accumulate and a merge step would be machinery for a wire shape
          // that is never produced.
          if (choice?.delta?.tool_calls) job.toolCalls = choice.delta.tool_calls;
          if (chunk.usage) job.usage = chunk.usage;
          // The chunk goes on verbatim. It is already a compliant OpenAI
          // envelope carrying id / created / model / logprobs /
          // system_fingerprint; rebuilding one downstream only loses fields.
          job.onChunk(chunk);
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
      ...(job.toolCalls ? { toolCalls: job.toolCalls } : {}),
      // Interrupted work reports "abort" whatever the stream last said.
      finishReason: extra.cancelled || extra.preempted ? "abort" : job.finishReason,
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
