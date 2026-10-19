import { parseCSV, sampleAt } from "../data.js";
import { errorMessage } from "../messages.js";
import { analyseProfile, profileMapping, compareProfiles } from "./model.js";

// Full logs stay in the worker. Only bounded display curves cross the boundary.
const sources = new Map();
let queue = Promise.resolve();
const metadata = (source) => ({
  id: source.id, name: source.file.name, size: source.file.size,
  start: source.data.start, end: source.data.end,
  count: source.data.points.length, sourceUnits: source.data.sourceUnits,
  rate: (source.data.points.length - 1) / source.data.duration,
});
async function handle(request) {
  if (request.type === "import") {
    const records = [], errors = [];
    for (const entry of request.entries) {
      try {
        const file = entry.file ?? sources.get(entry.id)?.file;
        const data = parseCSV(await file.text(), entry.settings);
        const source = { id: entry.id, file, data, cacheKey: null, stats: null };
        sources.set(entry.id, source);
        records.push(metadata(source));
      } catch (error) {
        errors.push({ id: entry.id, name: entry.file?.name ?? sources.get(entry.id)?.file.name, error: errorMessage(error) });
      }
    }
    return { records, errors };
  }
  if (request.type === "remove") {
    sources.delete(request.id);
    return {};
  }
  if (request.type === "analyze") {
    const records = request.profiles.map((profile) => {
      const source = sources.get(profile.id);
      if (!source) return { id: profile.id, error: errorMessage(new Error("Missing profile")) };
      try {
        const options = { ...profile.options, threshold: request.threshold, noiseWindow: request.noiseWindow };
        const cacheKey = JSON.stringify(options);
        if (source.cacheKey !== cacheKey) {
          source.stats = analyseProfile(source.data, options);
          source.cacheKey = cacheKey;
        }
        return { id: profile.id, stats: source.stats, mapping: profileMapping(source.stats, request.alignment), difference: null };
      } catch (error) { return { id: profile.id, error: errorMessage(error) }; }
    });
    const reference = records.find((record) => record.id === request.reference);
    for (const record of records) {
      if (!record.stats || !record.mapping || !reference?.stats || !reference.mapping) continue;
      const mapped = (item, event) => Number.isFinite(item.stats[event])
        ? item.mapping.offset + item.stats[event] * item.mapping.scale : null;
      const bounds = [mapped(reference, "start"), mapped(reference, "end"), mapped(record, "start"), mapped(record, "end")];
      if (bounds.some((value) => value === null)) continue;
      const start = Math.max(bounds[0], bounds[2]), end = Math.min(bounds[1], bounds[3]);
      if (end <= start) continue;
      record.difference = compareProfiles(sources.get(reference.id).data, reference.mapping,
        sources.get(record.id).data, record.mapping, { start, end });
    }
    return { records };
  }
  if (request.type === "sample") {
    return { samples: request.profiles.map(({ id, mapping }) => {
      const source = sources.get(id);
      const time = (request.x - mapping.offset) / mapping.scale;
      return { id, time, point: source ? sampleAt(source.data, time) : null };
    }) };
  }
  throw new Error("Unknown profile worker operation");
}
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try { self.postMessage({ requestId: data.requestId, result: await handle(data) }); }
    catch (error) { self.postMessage({ requestId: data.requestId, error: errorMessage(error) }); }
  });
};
