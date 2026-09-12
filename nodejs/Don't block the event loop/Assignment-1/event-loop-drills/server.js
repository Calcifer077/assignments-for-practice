const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const dns = require("dns");
const bfj = require("bfj");
const stream = require("stream");
const { Worker } = require("worker_threads");
const path = require("path");

const app = express();

// Route 1: fine as-is, your baseline
app.get("/ping", (req, res) => res.send("pong"));

// Route 2: broken — fix in Part A
app.get("/sum", (req, res) => {
  const n = Number(req.query.n) || 1e9;

  let sum = 0;
  for (let i = 0; i <= n; i++) sum += i;
  res.json({ sum });
});

function asyncSum(n, sumCB) {
  let sum = 0;
  let i = 1;
  const chunk = 100_000;

  function help() {
    const end = Math.min(i + chunk, n + 1);
    for (; i < end; i++) {
      sum += i;
    }

    if (i > n) {
      sumCB(sum);
      return;
    }

    setImmediate(help);
  }

  help();
}

app.get("/sum-partitioned", async (req, res) => {
  const n = Number(req.query.n) || 1e9;

  asyncSum(n, (sum) => res.json({ sum }));
});

app.get("/sum-worker", (req, res) => {
  const n = Number(req.query.n) || 1e9;
  let responded = false;

  const worker = new Worker(path.join(__dirname, "sum-worker-unpooled.js"), {
    workerData: { n },
  });

  worker.on("message", (sum) => {
    if (responded) return;
    responded = true;

    res.json({ sum });
  });

  worker.on("error", (err) => {
    if (responded) return;
    responded = true;
    res.status(500).json({ error: err.message });
  });
});

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

// Route 3: broken — fix in Part B
app.get("/validate-path", (req, res) => {
  const p = req.query.p || "";
  const valid = /^(\/.+)+$/.test(p);

  res.json({ valid });
});

app.get("/validate-path-fixed", (req, res) => {
  const p = req.query.p || "";

  if (p.length > 200) return res.json({ valid: false });

  const valid =
    p.startsWith("/") &&
    p
      .split("/")
      .slice(1)
      .every((segment) => segment.length > 0);

  res.json({ valid });
});

// Route 4: broken — fix in Part C
app.get("/hash", (req, res) => {
  const data = req.query.data || "hello";
  const hash = crypto.pbkdf2Sync(data, "salt", 100000, 64, "sha512");
  res.json({ hash: hash.toString("hex") });
});

app.get("/hash-async", (req, res) => {
  const data = req.query.data || "hello";

  crypto.pbkdf2(data, "salt", 100000, 64, "sha512", (err, derivedKey) => {
    if (err) {
      res.status(500).json({ error: "hash failed" });
      return;
    }
    res.json({ hash: derivedKey.toString("hex") });
  });
});

app.get("/dns", (req, res) => {
  const start = Date.now();
  dns.lookup("youtube.com", (err, address) => {
    if (err) {
      res.status(500).json({ error: "lookup failed" });
      return;
    }
    res.json({ address, took_ms: Date.now() - start });
  });
});

// Route 5: broken — fix in Part D
app.get("/read-log", (req, res) => {
  const contents = fs.readFileSync("./big.log", "utf8");
  res.json({ length: contents.length });
});

// async readFile
app.get("/read-log-async", (req, res) => {
  fs.readFile("./big.log", "utf-8", (err, data) => {
    if (err) {
      return res.status(500).json({ error: "file read failed" });
    }

    res.json({ length: data.length });
  });
});

app.get("/read-log-stream", (req, res) => {
  const readStream = fs.createReadStream("./big.log", { encoding: "utf-8" });

  let data = "";

  readStream.on("data", (chunk) => {
    // console.log("--- NEW CHUNK RECEIVED --- ");
    data += chunk;
  });

  readStream.on("end", () => {
    console.log("Finished reading the entire file.");
    return res.json({ length: data.length });
  });

  // Handle any errors (e.g., file not found)
  readStream.on("error", (err) => {
    console.error("An error occurred:", err.message);

    return res.status(500).json({ error: "file read failed" });
  });
});

app.get("/json-sync", (req, res) => {
  let obj = { a: 1 };
  const iterations = Number(req.query.iterations) || 20;

  // Expand the object exponentially by nesting it
  for (let i = 0; i < iterations; i++) {
    obj = { obj1: obj, obj2: obj };
  }
  // Measure time to stringify the object
  let start = process.hrtime.bigint();
  const jsonString = JSON.stringify(obj);
  let end = process.hrtime.bigint();

  let jsonStringifyduration = end - start;

  // Measure time to search a string within the JSON
  start = process.hrtime.bigint();
  const index = jsonString.indexOf("nomatch"); // Always -1
  end = process.hrtime.bigint();
  let stringIndexOfduration = end - start;

  // Measure time to parse the JSON back to an object
  start = process.hrtime.bigint();
  const parsed = JSON.parse(jsonString);
  end = process.hrtime.bigint();
  const jsongParseduration = end - start;

  const toMs = (ns) => Number(ns) / 1e6;

  res.json({
    stringify_ms: toMs(jsonStringifyduration),
    indexOf_ms: toMs(stringIndexOfduration),
    parse_ms: toMs(jsongParseduration),
    total_ms: toMs(
      jsonStringifyduration + stringIndexOfduration + jsongParseduration,
    ),
  });
});

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
    const stringifyDuration = process.hrtime.bigint() - start;

    start = process.hrtime.bigint();
    const index = jsonString.indexOf("nomatch"); // still sync, still O(n) — fine, it's cheap
    const indexOfDuration = process.hrtime.bigint() - start;

    start = process.hrtime.bigint();
    const jsonStream = stream.Readable.from(jsonString);
    const parsed = await bfj.parse(jsonStream);
    const parseDuration = process.hrtime.bigint() - start;

    res.json({
      stringify_ms: toMs(stringifyDuration),
      indexOf_ms: toMs(indexOfDuration),
      parse_ms: toMs(parseDuration),
      total_ms: toMs(stringifyDuration + indexOfDuration + parseDuration),
    });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "json processing failed" });
  }
});

app.get("/read-big", (req, res) => {
  const start = process.hrtime.bigint();
  fs.readFile("./big.log", "utf8", (err, contents) => {
    if (err) return res.status(500).json({ error: "read failed" });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`[big] took ${ms.toFixed(1)}ms`);
    res.json({ length: contents.length, took_ms: ms });
  });
});

app.get("/read-tiny", (req, res) => {
  const start = process.hrtime.bigint();
  fs.readFile("./tiny.log", "utf8", (err, contents) => {
    if (err) return res.status(500).json({ error: "read failed" });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`[tiny] took ${ms.toFixed(1)}ms`);
    res.json({ length: contents.length, took_ms: ms });
  });
});

app.listen(3000, () => console.log("listening on 3000"));
