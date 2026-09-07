Here's a hands-on assignment built directly around that article. It's structured as a broken Express server you fix in stages — much better for retention than abstract exercises.

## Setup

```bash
mkdir event-loop-drills && cd event-loop-drills
npm init -y
npm install express
```

Create `server.js` with this **intentionally bad** starting point:

```js
const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const app = express();

// Route 1: fine as-is, your baseline
app.get("/ping", (req, res) => res.send("pong"));

// Route 2: broken — fix in Part A
app.get("/sum", (req, res) => {
  const n = Number(req.query.n) || 1e9;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += i;
  res.json({ sum });
});

// Route 3: broken — fix in Part B
app.get("/validate-path", (req, res) => {
  const p = req.query.p || "";
  const valid = /^(\/.+)+$/.test(p);
  res.json({ valid });
});

// Route 4: broken — fix in Part C
app.get("/hash", (req, res) => {
  const data = req.query.data || "hello";
  const hash = crypto.pbkdf2Sync(data, "salt", 100000, 64, "sha512");
  res.json({ hash: hash.toString("hex") });
});

// Route 5: broken — fix in Part D
app.get("/read-log", (req, res) => {
  const contents = fs.readFileSync("./big.log", "utf8");
  res.json({ length: contents.length });
});

app.listen(3000, () => console.log("listening on 3000"));
```

Generate a big test file: `node -e "require('fs').writeFileSync('big.log', 'x'.repeat(200_000_000))"`

## The drill (do this for every part)

1. Hit `/ping` in one terminal in a tight loop (`while true; do curl -s localhost:3000/ping; done`) to visualize responsiveness.
2. In another terminal, hit the broken route with a heavy payload.
3. Watch `/ping` stall — that's the Event Loop (or Worker Pool) blocked.
4. Fix it. Confirm `/ping` stays snappy under load.

---

### Part A — CPU-bound blocking (partitioning)

`/sum?n=5000000000` freezes everything. Rewrite `/sum` using the `asyncAvg` partitioning pattern from the article (`setImmediate` recursion, chunked loop) so `/ping` never stalls, no matter how big `n` is. Then note: does this scale across CPU cores? Why not?

### Part B — ReDoS

`/validate-path?p=` + `'/a'.repeat(30) + '\n'` should hang. Identify why `(\/.+)+$` is vulnerable (nested quantifier), then fix it — either with a non-vulnerable regex or by swapping in a bounded/linear string check.

### Part C — Sync core APIs, CPU flavor

`pbkdf2Sync` blocks the Event Loop entirely. Replace it with `crypto.pbkdf2` (async, offloads to the Worker Pool). Then, separately, hammer `/hash` with 10 concurrent requests and watch what happens to the Worker Pool's other consumer (add a `/dns` route using `dns.lookup` as a canary) — this demonstrates the "k Workers" ceiling from the article.

### Part D — Sync core APIs, I/O flavor

Replace `fs.readFileSync` with the async `fs.readFile` or a streaming approach. Bonus: implement it with `fs.createReadStream` instead of `fs.readFile` and explain from the article why streaming is the "properly partitioned" version.

### Part E — JSON DOS (build from scratch)

Add a route that receives a POST body, builds a deeply nested object (reuse the article's exponential-nesting snippet), and does `JSON.stringify` + `JSON.parse` on it synchronously. Measure timing with `process.hrtime()`. Then look up (or stub) `JSONStream` or `bfj` and describe — in a comment, no need to fully implement — how you'd restructure this to avoid blocking.

### Part F — Worker Pool variance (capstone)

Set `UV_THREADPOOL_SIZE=2` and create two routes: one that reads a tiny file, one that reads `big.log`. Fire 2 concurrent requests to the big-file route, then a request to the tiny-file route. Time how long the tiny request takes. This should make the "each long Task shrinks the Worker Pool by one" line from the article visceral rather than theoretical.

---

**Stretch goal:** pick one CPU-bound route (Part A or C) and offload it properly using `worker_threads` instead of partitioning, then compare throughput under concurrent load with `autocannon` (`npm i -g autocannon`, then `autocannon -c 50 -d 10 localhost:3000/sum?n=...`).

Want me to also give you a **starter `worker_threads` offloading example** for the stretch goal, or do you want to attempt it cold first and check your solution against mine after?
