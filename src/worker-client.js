// @ts-check
import { UserError } from "./messages.js";

/** @typedef {{resolve:(result:unknown)=>void,reject:(error:unknown)=>void}} PendingRequest */
/** @typedef {{requestId:number,result?:unknown,error?:import("./messages.js").Message}} WorkerResponse */

/** Run identified requests in one lazily created worker with explicit ownership.
 * @param {()=>Worker} createWorker
 */
export function createWorkerClient(createWorker) {
  /** @type {Worker|null} */
  let worker = null;
  let sequence = 0, disposed = false;
  /** @type {Map<number,PendingRequest>} */
  const pending = new Map();
  const cancelled = () => new DOMException("Analysis cancelled", "AbortError");

  /** @param {Error} [error] */
  function reset(error = cancelled()) {
    const previous = worker;
    worker = null;
    previous?.terminate();
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function start() {
    const active = createWorker();
    worker = active;
    active.onmessage = ({ data }) => {
      if (worker !== active) return;
      const response = /** @type {WorkerResponse|undefined} */ (data);
      const job = response && pending.get(response.requestId);
      if (!job) return;
      pending.delete(response.requestId);
      if (response.error) job.reject(new UserError(response.error.key, response.error.values));
      else job.resolve(response.result);
    };
    active.onerror = (event) => {
      if (worker !== active) return;
      event.preventDefault?.();
      reset(new Error(event.message || "The analysis worker failed."));
    };
    active.onmessageerror = () => {
      if (worker === active) reset(new Error("The analysis worker returned unreadable data."));
    };
    return active;
  }

  return {
    /** @param {Record<string,unknown>} payload @returns {Promise<unknown>} */
    request(payload) {
      if (disposed) return Promise.reject(cancelled());
      return new Promise((resolve, reject) => {
        const requestId = ++sequence;
        try {
          const active = worker ?? start();
          pending.set(requestId, { resolve, reject });
          active.postMessage({ ...payload, requestId });
        } catch (error) {
          pending.delete(requestId);
          reject(error);
        }
      });
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}
