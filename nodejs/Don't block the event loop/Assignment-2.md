Here's a multi-part coding assignment designed around every major concept from that guide. You'll start with a **broken server** and progressively harden it.

---

## 🎯 The Assignment: "Fix the DoS-prone API Server"

### Starter Code (Intentionally Broken)

Save this as `server.js`. It's a small Express-like HTTP server (using Node's built-in `http` module) that handles a few endpoints. Every endpoint has at least one blocking issue.

```javascript
const http = require("http");
const url = require("url");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");

// Simulated "database" of users
const users = new Array(1000).fill(0).map((_, i) => ({
  id: i,
  name: `User ${i}`,
  email: `user${i}@example.com`,
}));

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // ============================================
  // TASK 1: REDOS Vulnerability
  // ============================================
  if (parsed.pathname === "/validate-path") {
    const filePath = parsed.query.path || "";
    // VULNERABLE: Nested quantifiers + user-controlled input
    const isValid = /(\/.+)+$/.test(filePath);
    res.writeHead(200);
    res.end(JSON.stringify({ valid: isValid }));
    return;
  }

  // ============================================
  // TASK 2: Sync File I/O on Event Loop
  // ============================================
  if (parsed.pathname === "/read-file") {
    const filename = parsed.query.file || "small.txt";
    // VULNERABLE: Synchronous + no path validation
    const data = fs.readFileSync(filename, "utf8");
    res.writeHead(200);
    res.end(data);
    return;
  }

  // ============================================
  // TASK 3: CPU-Intensive Blocking on Event Loop
  // ============================================
  if (parsed.pathname === "/hash-password") {
    const password = parsed.query.password || "default";
    // VULNERABLE: Sync, CPU-intensive, unbounded input
    const hash = crypto.pbkdf2Sync(password, "salt", 100000, 64, "sha512");
    res.writeHead(200);
    res.end(hash.toString("hex"));
    return;
  }

  // ============================================
  // TASK 4: Large JSON DOS
  // ============================================
  if (parsed.pathname === "/process-json") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      // VULNERABLE: Unbounded JSON.parse on Event Loop
      const payload = JSON.parse(body);
      res.writeHead(200);
      res.end(`Received ${Object.keys(payload).length} keys`);
    });
    return;
  }

  // ============================================
  // TASK 5: Unpartitioned Heavy Computation
  // ============================================
  if (parsed.pathname === "/compute") {
    const n = parseInt(parsed.query.n || "10", 10);
    // VULNERABLE: O(n²) loop blocks Event Loop
    let result = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        result += Math.sqrt(i * j);
      }
    }
    res.writeHead(200);
    res.end(JSON.stringify({ result }));
    return;
  }

  // ============================================
  // TASK 6: Worker Pool Variation Attack
  // ============================================
  if (parsed.pathname === "/compress") {
    const size = parseInt(parsed.query.size || "100", 10);
    // VULNERABLE: Unpartitioned, variable-cost sync compression
    const buffer = crypto.randomBytes(size * 1024); // size in KB
    const compressed = zlib.deflateSync(buffer);
    res.writeHead(200);
    res.end(`Compressed ${buffer.length} bytes to ${compressed.length}`);
    return;
  }

  // ============================================
  // Health check (this one is fine)
  // ============================================
  if (parsed.pathname === "/health") {
    res.writeHead(200);
    res.end("ok");
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(3000, () => {
  console.log("Broken server running on http://localhost:3000");
});
```

---

## 📋 Your Tasks

### **Task 1: Fix the REDOS vulnerability**

`/validate-path?path=...`

**Problem:** The regex `(\/.+)+$` has nested quantifiers. An attacker can send `///.../\n` (100 slashes + newline) to freeze the Event Loop.

**Your fix:**

- Reject paths longer than a reasonable limit (e.g., 4096 chars)
- Replace the regex with a safe validation approach (hint: `indexOf`, `split`, or a bounded loop)
- Bonus: Write a small test script that proves the old code blocks for 5+ seconds, while your fix returns instantly.

---

### **Task 2: Eliminate synchronous file I/O**

`/read-file?file=...`

**Problem:** `fs.readFileSync()` blocks the Event Loop. Worse, there's no path validation — this is a directory traversal vulnerability.

**Your fix:**

- Use the **async** `fs.readFile()` or `fs.createReadStream()`
- Validate that the requested file is inside a safe directory (e.g., `./public/`) — reject `../etc/passwd`
- Bonus: Use `ReadStream` and pipe it to the response (this also helps with memory on large files)

---

### **Task 3: Offload CPU-intensive crypto**

`/hash-password?password=...`

**Problem:** `crypto.pbkdf2Sync()` is CPU-intensive and runs on the Event Loop.

**Your fix:**

- Switch to the **async** `crypto.pbkdf2()` (it uses the Worker Pool)
- Bound the password length — reject passwords longer than 256 characters
- Bonus: Add rate limiting logic (e.g., max 5 requests per IP per minute)

---

### **Task 4: Defend against JSON DOS**

`/process-json` (POST)

**Problem:** `JSON.parse()` is O(n) and can block for seconds on a 50MB payload.

**Your fix:**

- Reject requests with `Content-Length` > 1MB before reading the body
- Bonus: Use a streaming JSON parser like `JSONStream` or `big-friendly-json` to handle large arrays/objects without blocking

---

### **Task 5: Partition heavy computation**

`/compute?n=...`

**Problem:** The O(n²) loop blocks the Event Loop. For `n=100000`, the server becomes unresponsive.

**Your fix:**

- **Option A (Partitioning):** Break the work into chunks using `setImmediate()` / `setTimeout()` so the Event Loop can process other requests between chunks. Save state in a closure.
- **Option B (Offloading):** Move the computation to a `Worker` (using Node's `worker_threads` module) so it runs on a separate thread and uses multiple cores.

**Requirements:**

- Support `n` up to at least `1,000,000` without blocking `/health` checks
- A test script should fire `/compute?n=1000000` and simultaneously hit `/health` — both should return successfully.

---

### **Task 6: Fix Worker Pool variation**

`/compress?size=...`

**Problem:** `zlib.deflateSync()` blocks the Event Loop AND creates variable-cost tasks. An attacker can request `size=100000` to bog down the server.

**Your fix:**

- Use the **async** `zlib.deflate()` (uses Worker Pool)
- Cap `size` to a maximum (e.g., 10MB)
- Bonus: Instead of generating random bytes on the Event Loop (`crypto.randomBytesSync`), use the async `crypto.randomBytes()` first, then compress

---

## 🧪 Testing Your Fixes

Create `attack.js` to simulate malicious traffic:

```javascript
const http = require("http");

// Attack 1: REDOS
function attackRedos() {
  const evil = "/".repeat(100) + "\n";
  const start = Date.now();
  http.get(
    `http://localhost:3000/validate-path?path=${encodeURIComponent(evil)}`,
    () => {
      console.log(
        `REDOS request took ${Date.now() - start}ms (should be < 100ms)`,
      );
    },
  );
}

// Attack 2: Health check under load
function checkHealth() {
  http.get("http://localhost:3000/health", (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => console.log("Health:", data));
  });
}

// Attack 3: Big JSON
function attackJson() {
  const big = JSON.stringify({ data: "x".repeat(50 * 1024 * 1024) }); // 50MB string
  const req = http.request(
    {
      hostname: "localhost",
      port: 3000,
      path: "/process-json",
      method: "POST",
      headers: { "Content-Length": Buffer.byteLength(big) },
    },
    (res) => console.log("JSON status:", res.statusCode),
  );
  req.write(big);
  req.end();
}

// Run attacks while checking health
attackRedos();
attackJson();
setInterval(checkHealth, 100); // Should always respond "ok" quickly
```

**Success criteria:** While running `attack.js`, every `/health` check should return in under 50ms.

---

## 🏆 Bonus Challenges

1. **Implement a Computation Worker Pool:** Instead of creating a new Worker for every `/compute` request, create a pool of 4 Workers and distribute jobs to them. Benchmark throughput vs. the partitioning approach.

2. **Add Observability:** Add a middleware that tracks Event Loop lag using `process.hrtime()` or the `perf_hooks` module. Log a warning if any request handler takes > 100ms on the Event Loop.

3. **Stream Large Responses:** For `/read-file`, if the file is > 1MB, compress it on-the-fly using `zlib.createDeflate()` piped to the response, without ever loading the whole file into memory.

---

## 📤 Submission Format

When you're done, your repo should contain:

- `server.js` — the fixed, non-blocking server
- `attack.js` — your test/attack script
- `README.md` — explaining what you changed for each task and why

---

Want me to review your solution once you've written it, or need hints for any specific task?
