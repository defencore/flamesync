export function createProfileWorker() {
  let worker = null, sequence = 0;
  const pending = new Map();
  function dispose() {
    worker?.terminate();
    worker = null;
    for (const { reject } of pending.values()) reject(new DOMException("Analysis cancelled", "AbortError"));
    pending.clear();
  }
  return {
    request(data) {
      if (!worker) {
        worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
        worker.onmessage = ({ data }) => {
          const job = pending.get(data.requestId);
          if (!job) return;
          pending.delete(data.requestId);
          if (data.error) job.reject(Object.assign(new Error(data.error.key), { userMessage: data.error }));
          else job.resolve(data.result);
        };
        worker.onerror = (event) => {
          const error = new Error(event.message);
          for (const job of pending.values()) job.reject(error);
          pending.clear();
          worker?.terminate();
          worker = null;
        };
      }
      return new Promise((resolve, reject) => {
        const requestId = ++sequence;
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ ...data, requestId });
      });
    },
    dispose,
  };
}
