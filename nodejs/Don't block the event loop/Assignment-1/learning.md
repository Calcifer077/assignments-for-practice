# Don't Block the Event Loop — Assignment Notes

Based on: [Don't Block the Event Loop (or the Worker Pool) — Node.js Learn](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)

## Setup

To detect whether a route blocks the Event Loop, run a "heartbeat" probe in one terminal:

```bash
while true; do
  echo "$(date +%T.%3N) - $(curl -s -o /dev/null -w '%{http_code}' localhost:3000/ping)"
  sleep 0.2
done
```

(Run in Git Bash on Windows, or any bash shell on macOS/Linux.)

With the server running (`node server.js`) and this loop running in one terminal, hit any route under test from a **third** terminal. If a route blocks the Event Loop, the heartbeat loop **freezes** — no new lines print — for as long as the block lasts, then resumes (sometimes in a burst) once the blocking call finishes.

---

## Part A — Partitioning a CPU-bound loop

**Goal:** compute a large sum without blocking the Event Loop.

### First attempt: yield on every iteration

```js
function asyncSum(n, sumCB) {
  // save ongoing sum in JS closure
  let sum = 0;

  function help(i, cb) {
    sum += i;

    if (i == n) {
      cb(sum);
      return;
    }

    setImmediate(help.bind(null, i + 1, cb));
  }

  help(1, function (sum) {
    sumCB(sum);
  });
}
```

**Problem:** for `n = 1e9` this schedules **1 billion separate `setImmediate` ticks**. Each tick has real scheduling overhead, so this technically never blocks the Event Loop but is _extremely_ slow — far slower than the blocking synchronous version, just without freezing other requests.

### Fixed: chunked partitioning

```js
function asyncSum(n, sumCB) {
  let sum = 0;
  let i = 1;
  const CHUNK = 100_000;

  function help() {
    const end = Math.min(i + CHUNK, n + 1);
    for (; i < end; i++) sum += i;

    if (i > n) {
      sumCB(sum);
      return;
    }
    setImmediate(help);
  }

  help();
}
```

**How it works:**

- `sum`, `i`, and `CHUNK` live in the closure across ticks.
- Each call to `help()` synchronously sums a batch of `CHUNK` numbers (not just one), then checks whether the total is done.
- `Math.min(i + CHUNK, n + 1)` bounds the batch so the loop never overshoots `n`.
- If not done, `setImmediate(help)` yields back to the Event Loop, letting other pending callbacks (e.g. `/ping`) run before continuing.
- Result: one scheduled tick per `CHUNK` iterations instead of per iteration — a much better balance between throughput and fairness.

### Route

```js
app.get("/sum-partitioned", (req, res) => {
  const n = Number(req.query.n) || 1e9;
  asyncSum(n, (sum) => res.json({ sum }));
});
```

(Don't wrap this in `async`/`await` — `asyncSum` is callback-based, not Promise-based, so `await` on it does nothing useful.)

### Key takeaway

> **Partitioning does not make the computation faster — it only prevents it from blocking the Event Loop.** All the actual work still runs on a single thread, one chunk at a time. If several concurrent requests all run partitioned work, they share the same thread and take turns; total throughput is still bounded by single-core speed. Partitioning trades raw throughput for _fairness_ to other pending requests.

---

## Part B — Regex Denial of Service (ReDoS)

### The vulnerable code

```js
const valid = /^(\/.+)+$/.test(p);
```

This pattern has a **nested quantifier** (`(\/.+)+`), which can force the regex engine into exponential-time backtracking on certain "evil" inputs (e.g. many `/` characters followed by a character that fails to match, like a trailing newline). On such input, this line can block the Event Loop for a very long time.

### The fix: replace the regex with bounded, linear string operations

First, understand _what_ the regex was checking: is the string a sequence of `/`-delimited, non-empty segments (like a Linux path — `/a/b/c`)?

```js
app.get("/validate-path", (req, res) => {
  const p = req.query.p || "";

  // Reject overly long input outright — bounds worst-case cost
  if (p.length > 200) return res.json({ valid: false });

  const valid =
    p.startsWith("/") &&
    p
      .split("/")
      .slice(1)
      .every((segment) => segment.length > 0);

  res.json({ valid });
});
```

- `startsWith("/")` — must begin with a slash.
- `split("/").slice(1)` — split into segments, dropping the empty string before the leading slash.
- `.every(segment => segment.length > 0)` — rejects empty segments (e.g. `"/a//b"` or `"/"` alone), preserving the original regex's intent.
- The `length > 200` guard is a second line of defense from the article's other suggested mitigation: _bound the input, reject anything unreasonably long_, so even a cheap check can't be abused with pathological input sizes.

All of `startsWith`, `split`, and `every` are `O(n)`, single-pass, and have no backtracking — they cannot go exponential.

### Test cases

| Input                                        | Expected                              |
| -------------------------------------------- | ------------------------------------- |
| `/a/b/c`                                     | `true`                                |
| `/a//b`                                      | `false` (empty segment)               |
| `/`                                          | `false` (no segments)                 |
| `'/a'.repeat(30) + '\n'` (the ReDoS payload) | Returns instantly, `/ping` unaffected |

---

## Part C — Expensive synchronous core APIs

### The vulnerable code

```js
const hash = crypto.pbkdf2Sync(data, "salt", 100000, 64, "sha512");
```

`pbkdf2Sync` runs entirely on the Event Loop and can take a long time for high iteration counts — blocking every other pending request for the duration.

### The fix: use the async, callback-based version

```js
app.get("/hash", (req, res) => {
  const data = req.query.data || "hello";

  crypto.pbkdf2(data, "salt", 100000, 64, "sha512", (err, derivedKey) => {
    if (err) {
      res.status(500).json({ error: "hash failed" });
      return;
    }
    res.json({ hash: derivedKey.toString("hex") });
  });
});
```

`crypto.pbkdf2` (no `Sync`) offloads the actual computation to Node's **Worker Pool** (libuv threadpool) instead of the Event Loop. It doesn't return a value directly — the result only arrives via the callback once the Worker Pool task completes.

### Observing the Worker Pool ceiling

```bash
for i in $(seq 1 10); do curl -s "localhost:3000/hash?data=x$i" & done; wait
```

Fires 10 concurrent hash requests. With the **default Worker Pool size of 4**, you'd expect the results to complete in waves of 4 — but this is only clearly visible if each task takes long enough (e.g. a higher iteration count like `2_000_000`) relative to the overhead of firing the requests themselves. At low iteration counts, tasks may finish faster than new requests even arrive, muddying the "wave" pattern.

**To change the Worker Pool size, set the `UV_THREADPOOL_SIZE` environment variable _before starting the server_** (this cannot be changed at runtime):

```bash
# bash / Git Bash
UV_THREADPOOL_SIZE=2 node server.js
```

```powershell
# PowerShell
$env:UV_THREADPOOL_SIZE=2; node server.js
```

> Will be available on `process.env` variable.

### `/dns` as a canary route

Since `dns.lookup()` also uses the Worker Pool, it can be used to detect Worker Pool saturation from unrelated work:

```js
const dns = require("dns");

app.get("/dns", (req, res) => {
  const start = Date.now();
  dns.lookup("example.com", (err, address) => {
    if (err) return res.status(500).json({ error: "lookup failed" });
    res.json({ address, took_ms: Date.now() - start });
  });
});
```

If several `pbkdf2` requests are occupying all Worker threads, a concurrent `/dns` request — normally near-instant — will visibly queue behind them, since it can't get a thread until one frees up.

### Best way to measure timing accurately

Prefer server-side `console.log` timestamps (via `process.hrtime.bigint()`) over client-side `curl` timing — `curl`/shell overhead (forking processes, DNS resolution for `localhost`, etc.) can distort measurements at millisecond resolution, especially when firing many concurrent requests from a `for` loop.

---

## Part D — Blocking file reads

### The vulnerable code

```js
const contents = fs.readFileSync("./big.log", "utf8");
```

Runs synchronously on the Event Loop — for a large file, this blocks everything for the duration of the read.

### Fix 1: `fs.readFile` (async)

```js
app.get("/read-log", (req, res) => {
  fs.readFile("./big.log", "utf-8", (err, data) => {
    if (err) return res.status(500).json({ error: "file read failed" });
    res.json({ length: data.length });
  });
});
```

Modern Node (`fs.readFile` since ~v10) internally partitions large reads into a series of smaller `fs.read()` calls submitted to the Worker Pool, rather than one single monolithic Task — an improvement over older Node versions. This means the Event Loop is never blocked, and even the Worker Pool task itself is chunked so other pending Worker Pool tasks can interleave.

### Fix 2: `fs.createReadStream`

```js
app.get("/read-log-stream", (req, res) => {
  const readStream = fs.createReadStream("./big.log", { encoding: "utf-8" });
  let data = "";

  readStream.on("data", (chunk) => {
    data += chunk;
  });

  readStream.on("end", () => {
    res.json({ length: data.length });
  });

  readStream.on("error", (err) => {
    res.status(500).json({ error: "file read failed" });
  });
});
```

**Why streaming counts as "properly partitioned":** Node.js automatically breaks the file into bounded-size chunks (default `highWaterMark` of 64KB) and emits a `data` event per chunk rather than reading the whole file in one Worker Pool Task. Each chunk read is its own small, bounded-cost Task — between chunks, the same Worker thread is free to pick up other pending Tasks (e.g. another user's file read or hash computation) before continuing this one. This is the Worker-Pool-side analogue of Part A's Event-Loop-side chunking via `setImmediate`: instead of one Task with unpredictable, unbounded duration, you get many small Tasks with predictable, bounded duration — directly addressing the article's "minimize variation in Task times" guidance.

**Caveat:** accumulating `data += chunk` for the whole file still holds the entire contents in memory at the end, so this example doesn't capture streaming's _memory_ benefit — only its _Worker Pool fairness_ benefit. A more realistic use case pipes each chunk elsewhere (a response, a hash, a transform) instead of concatenating.

---

## Part E — JSON DoS

### The problem

`JSON.stringify` and `JSON.parse` are `O(n)` in input size, but for very large objects/strings, `n` can be large enough that a single call meaningfully blocks the Event Loop.

### Reproducing it (synchronous, blocking version)

```js
app.get("/json-block", (req, res) => {
  let obj = { a: 1 };
  const iterations = Number(req.query.iterations) || 20;

  for (let i = 0; i < iterations; i++) {
    obj = { obj1: obj, obj2: obj };
  }

  const toMs = (ns) => Number(ns) / 1e6;

  let start = process.hrtime.bigint();
  const jsonString = JSON.stringify(obj);
  const stringifyMs = toMs(process.hrtime.bigint() - start);

  start = process.hrtime.bigint();
  jsonString.indexOf("nomatch");
  const indexOfMs = toMs(process.hrtime.bigint() - start);

  start = process.hrtime.bigint();
  JSON.parse(jsonString);
  const parseMs = toMs(process.hrtime.bigint() - start);

  res.json({
    stringify_ms: stringifyMs,
    indexOf_ms: indexOfMs,
    parse_ms: parseMs,
    total_ms: stringifyMs + indexOfMs + parseMs,
  });
});
```

Each doubling of `iterations` roughly doubles the object size (exponential nesting), so bumping `iterations` from ~20 to ~23 is usually enough to produce a visible stall in the `/ping` heartbeat.

### The fix: `bfj` (Big-Friendly JSON)

`bfj` provides asynchronous, streaming-friendly stringify/parse that avoid blocking the Event Loop for a single long synchronous pass — at the cost of being slower overall than native `JSON.stringify`/`JSON.parse`.

```js
const bfj = require("bfj");
const stream = require("stream");

app.get("/json-bfj", async (req, res) => {
  let obj = { a: 1 };
  const iterations = Number(req.query.iterations) || 20;

  for (let i = 0; i < iterations; i++) {
    obj = { obj1: obj, obj2: obj };
  }

  const toMs = (ns) => Number(ns) / 1e6;

  try {
    let start = process.hrtime.bigint();
    const jsonString = await bfj.stringify(obj);
    const stringifyMs = toMs(process.hrtime.bigint() - start);

    start = process.hrtime.bigint();
    jsonString.indexOf("nomatch");
    const indexOfMs = toMs(process.hrtime.bigint() - start);

    // bfj.parse requires a stream, not a plain string —
    // wrap the string before parsing
    start = process.hrtime.bigint();
    const jsonStream = stream.Readable.from(jsonString);
    await bfj.parse(jsonStream);
    const parseMs = toMs(process.hrtime.bigint() - start);

    res.json({
      stringify_ms: stringifyMs,
      indexOf_ms: indexOfMs,
      parse_ms: parseMs,
      total_ms: stringifyMs + indexOfMs + parseMs,
    });
  } catch (err) {
    res.status(500).json({ error: "json processing failed" });
  }
});
```

**Key API asymmetry to remember:**

- `bfj.stringify(value)` accepts a plain JS value directly.
- `bfj.parse(stream)` requires a **readable stream** of JSON text, not a string — hence wrapping with `stream.Readable.from(jsonString)`.

**Note on realism:** converting an in-memory string into a stream just to satisfy `bfj.parse`'s API is a bit contrived, since the "giant string in memory" problem is already present by that point. `bfj.parse` is more naturally suited to input that's _already_ a stream from the start — e.g. `fs.createReadStream('data.json')` reading JSON directly off disk, or an incoming HTTP request body.

Use `async`/`await` rather than manual `.then()` chaining here — it guarantees `res.json(...)` can't execute before the awaited work resolves (a real bug in an earlier `.then()`-based draft, where the response was sent immediately with `undefined`/`NaN` values before the promises settled).

### Key takeaway

> `bfj` is not fast — it's intentionally slower than native `JSON.stringify`/`JSON.parse` — but it guarantees the Event Loop is never blocked for a long single pass, trading raw speed for responsiveness under large payloads.

---

## Part F — Worker Pool task variance

**Goal:** demonstrate that a long-running Worker Pool Task can starve short ones, per the article's "minimize variation in Task times" guidance.

### Routes

```js
app.get("/read-big", (req, res) => {
  fs.readFile("./big.log", "utf8", (err, contents) => {
    if (err) return res.status(500).json({ error: "read failed" });
    res.json({ length: contents.length });
  });
});

app.get("/read-tiny", (req, res) => {
  fs.readFile("./tiny.log", "utf8", (err, contents) => {
    if (err) return res.status(500).json({ error: "read failed" });
    res.json({ length: contents.length });
  });
});
```

### Finding: with `fs.readFile`, the expected starvation didn't clearly appear

Running with `UV_THREADPOOL_SIZE=2` and firing several concurrent `/read-big` requests alongside `/read-tiny` did **not** noticeably slow down the tiny read, even though naively this looks like it should saturate a 2-thread pool.

**Why:** as established in Part D, `fs.readFile` is already internally partitioned into a series of small `fs.read()` calls rather than one monolithic Task. Between each small internal read, the Worker thread is freed up and can service other pending Tasks (like `/read-tiny`) before resuming the big read. Additionally, after the first read, `big.log` is likely served from the OS file cache, making subsequent reads very fast regardless of size — reducing any real disk-bound cost.

**In other words:** this "failed" experiment actually _confirms_ the article's implied fix works — `fs.readFile`'s own internal partitioning is precisely what prevents the starvation this part set out to observe.

### Forcing a genuinely monolithic Task (to observe real starvation)

To see the starvation effect the article describes, you need a Task that is _not_ internally chunked — one raw syscall covering the whole payload:

**Option A — a single raw `fs.read()` call:**

```js
app.get("/read-big-single", (req, res) => {
  fs.stat("./big.log", (err, stats) => {
    if (err) return res.status(500).json({ error: "stat failed" });
    fs.open("./big.log", "r", (err, fd) => {
      if (err) return res.status(500).json({ error: "open failed" });
      const buffer = Buffer.alloc(stats.size);
      fs.read(fd, buffer, 0, stats.size, 0, (err, bytesRead) => {
        fs.close(fd, () => {});
        res.json({ bytesRead });
      });
    });
  });
});
```

**Option B — reuse `/hash` (`pbkdf2`) as the "long" task**, since it genuinely runs as one uninterruptible Worker Pool Task for its full duration (not internally partitioned):

```bash
UV_THREADPOOL_SIZE=2 node server.js
```

```bash
curl -s "localhost:3000/hash?data=x1" -o /dev/null -w "hash1: %{time_total}s\n" &
curl -s "localhost:3000/hash?data=x2" -o /dev/null -w "hash2: %{time_total}s\n" &
curl -s "localhost:3000/read-tiny" -o /dev/null -w "tiny: %{time_total}s\n" &
wait
```

With two genuinely monolithic long tasks occupying both threads of a 2-thread pool, `/read-tiny` should now visibly queue behind them.

---

## Overall Key Takeaway: Partitioning ≠ Speed

> **Partitioning and async APIs make sure the Event Loop (or Worker Pool) isn't monopolized by one client's request — they do not make the underlying computation finish any faster.** All the real work still executes somewhere, at the same total cost; partitioning only controls _when_ other pending work gets a turn in between.

Demonstration:

```bash
curl "localhost:3000/sum" & curl "localhost:3000/ping"
```

Here, only `/sum` is computationally expensive — `/ping` does almost nothing. But because the naive `/sum` blocks the Event Loop, `/ping` is forced to wait far longer than its own work would ever require. A partitioned version of `/sum` would let `/ping` return promptly, but the partitioned `/sum` itself may take _longer in total_ than the blocking version, because of scheduling overhead — it just no longer holds anyone else hostage while doing so.

---

## Worker Threads: Real Parallelism vs. Partitioning

Partitioning (`setImmediate` chunking) keeps the Event Loop responsive but confines all work to a single thread — concurrent requests take turns, they don't run simultaneously. `worker_threads` provides genuine parallelism by running work on separate OS threads (and, when available, separate CPU cores).

### Naive: one Worker per request

`sum-worker.js`:

```js
const { parentPort, workerData } = require("worker_threads");

const { n } = workerData;
let sum = 0;
for (let i = 1; i <= n; i++) sum += i;

parentPort.postMessage(sum);
```

`server.js`:

```js
const { Worker } = require("worker_threads");
const path = require("path");

app.get("/sum-worker", (req, res) => {
  const n = Number(req.query.n) || 1e9;

  const worker = new Worker(path.join(__dirname, "sum-worker.js"), {
    workerData: { n },
  });

  worker.on("message", (sum) => res.json({ sum }));
  worker.on("error", (err) => res.status(500).json({ error: err.message }));
});
```

**Problem found:** this was consistently ~100x slower than the partitioned or even the naive synchronous version, _despite_ fully utilizing all logical CPU cores. Spawning a `Worker` requires creating an entirely new V8 isolate (separate JS engine instance, own heap, own compiled built-ins) and tearing it down afterward — a fixed cost of roughly tens to low-hundreds of milliseconds per request, regardless of how small the actual computation is. For workloads where the real work only takes single-digit milliseconds, this overhead completely dominates.

### Fix: a worker pool (long-lived, reused workers)

`sum-worker.js` (rewritten to handle repeated messages):

```js
const { parentPort } = require("worker_threads");

parentPort.on("message", ({ n, id }) => {
  let sum = 0;
  for (let i = 1; i <= n; i++) sum += i;
  parentPort.postMessage({ sum, id });
});
```

`server.js`:

```js
const { Worker } = require("worker_threads");
const path = require("path");

const POOL_SIZE = require("os").cpus().length;
const pool = [];
const pending = new Map();
let nextId = 0;
let rrIndex = 0;

for (let i = 0; i < POOL_SIZE; i++) {
  const worker = new Worker(path.join(__dirname, "sum-worker.js"));
  worker.on("message", ({ sum, id }) => {
    const resolve = pending.get(id);
    pending.delete(id);
    resolve(sum);
  });
  pool.push(worker);
}

function runSumOnPool(n) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const worker = pool[rrIndex];
    rrIndex = (rrIndex + 1) % pool.length;
    worker.postMessage({ n, id });
  });
}

app.get("/sum-worker-pooled", async (req, res) => {
  const n = Number(req.query.n) || 1e9;
  const sum = await runSumOnPool(n);
  res.json({ sum });
});
```

Workers are created **once**, at server startup — the expensive isolate-creation cost is paid `POOL_SIZE` times total instead of once per request. After that, each request just posts a message and awaits a reply — no repeated spawn/teardown.

---

## Benchmark Results (`autocannon`)

All tests: `autocannon -c <connections> -d 10 "localhost:3000/<route>?n=<n>"`

**10 connections, n = 5,000:**

| Route                             | Req/sec |
| --------------------------------- | ------- |
| `/sum` (naive sync)               | 3,090.8 |
| `/sum-partitioned`                | 2,668.2 |
| `/sum-worker` (spawn-per-request) | 49.8    |

**30 connections, n = 5,000:**

| Route              | Req/sec |
| ------------------ | ------- |
| `/sum`             | 5,904   |
| `/sum-partitioned` | 3,828   |
| `/sum-worker`      | 48      |

**10 connections, n = 50,000:**

| Route                | Req/sec | CPU usage |
| -------------------- | ------- | --------- |
| `/sum`               | 2,470.4 | ~23%      |
| `/sum-partitioned`   | 1,496.4 | ~25%      |
| `/sum-worker`        | 45.9    | ~98%      |
| `/sum-worker-pooled` | 2,349.9 | ~30%      |

**10 connections, n = 500,000:**

| Route                | Req/sec | CPU usage |
| -------------------- | ------- | --------- |
| `/sum`               | 586.21  | ~20%      |
| `/sum-partitioned`   | 164.1   | ~20%      |
| `/sum-worker`        | 46.4    | ~100%     |
| `/sum-worker-pooled` | 2,723.5 | ~70%      |

**10 connections, n = 5,000,000:**

| Route                | Req/sec | CPU usage |
| -------------------- | ------- | --------- |
| `/sum`               | 70.2    | <20%      |
| `/sum-partitioned`   | 7       | ~22%      |
| `/sum-worker`        | 43.4    | ~99%      |
| `/sum-worker-pooled` | 551.21  | ~99%      |

### Observations

- **`/sum` (naive sync):** fast for small `n`, but throughput collapses drastically as `n` grows — the single Event Loop thread is doing all the work, blocking everything else while it runs. CPU usage stays low (~20%) throughout because only one core is ever active, regardless of load.
- **`/sum-partitioned`:** similar CPU profile to `/sum` (still single-threaded, ~20-25%), but consistently _slower_ in raw throughput due to `setImmediate` scheduling overhead — the cost of staying non-blocking. Its advantage isn't speed; it's that it never blocks other unrelated requests (e.g. `/ping`) the way `/sum` does.
- **`/sum-worker` (spawn-per-request):** uses all available CPU cores (~98-100%) but stays _consistently_ slow regardless of `n` — the fixed per-request cost of spawning and tearing down a V8 isolate dominates at every scale tested here, swamping any parallelism benefit.
- **`/sum-worker-pooled`:** the clear winner as `n` grows. CPU usage climbs with load (30% → 70% → 99%) as more cores get genuinely engaged, and throughput degrades far more gracefully than the single-threaded options as `n` increases — at `n = 5,000,000` it outperforms every other route by roughly an order of magnitude.

### Overall conclusion

- For **small, cheap workloads**, plain synchronous code is fastest — any form of offloading (partitioning or workers) adds overhead that isn't worth paying.
- For **workloads large enough to risk blocking the Event Loop, but still cheap per-unit**, partitioning is the right tool — it sacrifices some throughput for fairness, without the fixed cost of spawning threads.
- For **genuinely heavy, CPU-bound workloads at scale**, a **pooled** `worker_threads` approach wins decisively, because it achieves true multi-core parallelism _and_ amortizes the one-time cost of thread/isolate creation across many requests.
- **Spawning a new Worker thread per request is close to always the wrong choice** — the isolate creation cost is large enough to erase the benefit of parallelism unless individual tasks are extremely heavy (heavy enough to dwarf tens-to-hundreds of milliseconds of spawn overhead).
