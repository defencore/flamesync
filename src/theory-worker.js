import { parseCSV, chartPoints } from "./data.js";
import { analyseProfile } from "./profiles/model.js";
import { errorMessage, UserError } from "./messages.js";

// Cache only the current source and one previous source. Rejected replacements
// never overwrite the last usable theoretical profile.
const sources = new Map();
let queue = Promise.resolve();

async function analyze(request) {
  let source = sources.get(request.key);
  if (!source) {
    if (!request.file || request.file.size > 20 * 1024 * 1024)
      throw new UserError("The theoretical CSV must be no larger than 20 MB.");
    const data = parseCSV(await request.file.text(), request.settings);
    source = { data, reduced: chartPoints(data, 2400) };
  }
  const stats = analyseProfile(source.data, { ...request.options, threshold: 5 });
  if (!sources.has(request.key)) {
    sources.set(request.key, source);
    while (sources.size > 2) sources.delete(sources.keys().next().value);
  }
  return { stats, ...(request.includeData ? source : {}) };
}

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      self.postMessage({ requestId: data.requestId, result: await analyze(data) });
    } catch (error) {
      self.postMessage({ requestId: data.requestId, error: errorMessage(error) });
    }
  });
};
