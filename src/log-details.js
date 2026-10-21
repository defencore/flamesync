import { logPositionAt } from "./data.js";

export function rowNumbers(position) {
  return position?.first ? `${position.first.line}${position.second ? ` → ${position.second.line}` : ""}` : "—";
}

export function logRowNumbers(data, time) {
  const thrust = rowNumbers(logPositionAt(data, time));
  return data?.separateTime ? `T ${thrust} · P ${rowNumbers(logPositionAt(data, time, "pressure"))}` : thrust;
}

export function logRateLabel(data) {
  if (!data) return "";
  const rate = (channel) => channel.duration > 0 ? ((channel.count - 1) / channel.duration).toFixed(1) : "—";
  return data.separateTime ? `T ${rate(data.channels.thrust)} · P ${rate(data.channels.pressure)} Hz`
    : `${rate(data.channels.thrust)} Hz`;
}
