// @ts-check
/** Preserve a frozen editor when the browser restores it from its history cache.
 * @param {{target?:Window,isExporting:()=>boolean,suspend:()=>void,resume:()=>void,dispose:()=>void}} options
 */
export function bindPageLifecycle({ target = window, isExporting, suspend, resume, dispose }) {
  const listeners = new AbortController();
  let warning = false, disposed = false;
  /** @param {BeforeUnloadEvent} event */
  function beforeUnload(event) {
    if (!isExporting()) return;
    event.preventDefault();
    event.returnValue = "";
  }
  function update() {
    const next = !disposed && Boolean(isExporting());
    if (next === warning) return;
    warning = next;
    if (warning) target.addEventListener("beforeunload", beforeUnload);
    else target.removeEventListener("beforeunload", beforeUnload);
  }
  function stop() {
    if (disposed) return;
    disposed = true;
    listeners.abort();
    if (warning) target.removeEventListener("beforeunload", beforeUnload);
    warning = false;
  }
  target.addEventListener("pagehide", (event) => {
    suspend();
    if (event.persisted) return;
    stop();
    dispose();
  }, { signal: listeners.signal });
  target.addEventListener("pageshow", (event) => {
    if (event.persisted) resume();
    update();
  }, { signal: listeners.signal });
  update();
  return { update, dispose: stop };
}
