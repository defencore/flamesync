import { parseCSV, sampleAt } from "../data.js";
import { errorMessage } from "../messages.js";
import { analyseProfile, profileMapping, compareProfiles } from "./model.js";
import { analyseSeries } from "./series-model.js";

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
    for (const record of request.series ? [] : records) {
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
    let series = null;
    if (request.series) {
      series = analyseSeries(request.profiles.map((profile) => ({ id: profile.id,
        included: profile.included, data: sources.get(profile.id)?.data,
        stats: profile.valid === false ? null : records.find((record) => record.id === profile.id)?.stats,
      })), { alignment: request.alignment });
      // Difference traces share the bounded display grid; scalar deviations
      // are calculated independently from original selected-interval metrics.
      series.curves = series.curve ? series.eligibleIds.map((id) => {
        const record = records.find((item) => item.id === id), data = sources.get(id).data;
        const points = series.curve.points.map((mean) => {
          const time = (mean.t - record.mapping.offset) / record.mapping.scale;
          const point = sampleAt(data, Math.max(data.start, Math.min(data.end, time)));
          return point ? { t: mean.t, thrust: point.thrust - mean.thrust, pressure: point.pressure - mean.pressure, gapBefore: mean.gapBefore } : null;
        }).filter(Boolean);
        return { id, points };
      }) : [];
      series.zeroCurve = series.curve?.points.map((point) => ({ ...point,
        thrustMin: point.thrustMin - point.thrust, thrustMax: point.thrustMax - point.thrust,
        pressureMin: point.pressureMin - point.pressure, pressureMax: point.pressureMax - point.pressure,
        thrust: 0, pressure: 0 })) ?? [];
    }
    return { records, series };
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
