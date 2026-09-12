const { parentPort, workerData } = require("worker_threads");

const { n } = workerData;
let sum = 0;
for (let i = 1; i <= n; i++) {
  sum += i;
}

parentPort.postMessage(sum);
