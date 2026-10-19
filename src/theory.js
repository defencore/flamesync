import { UserError } from "./messages.js";
import { compareProfiles } from "./profiles/model.js";

const IDENTITY = Object.freeze({ offset: 0, scale: 1 });

/** Validate a map from theoretical CSV seconds to measured CSV seconds. */
export function validateTheoryMapping(mapping) {
  if (!mapping || !Number.isFinite(mapping.offset) || !Number.isFinite(mapping.scale) || mapping.scale <= 0)
    throw new UserError("The theoretical alignment must have a finite offset and a positive time scale.");
  return mapping;
}

function hasEvent(profile, key) {
  return Number.isFinite(profile?.[key]);
}

function hasInterval(profile) {
  return hasEvent(profile, "start") && hasEvent(profile, "end") && profile.end > profile.start;
}

/** Align theory events to measured events without changing original statistics.
 * Only the explicit "both" mode changes the theoretical display duration. */
export function alignTheory(measured, theory, mode = "ignition") {
  if (mode === "source") return { ...IDENTITY };
  if (mode === "ignition" || mode === "burnout") {
    const key = mode === "ignition" ? "start" : "end";
    if (!hasEvent(measured, key) || !hasEvent(theory, key)) return null;
    return validateTheoryMapping({ offset: measured[key] - theory[key], scale: 1 });
  }
  if (mode === "both") {
    if (!hasInterval(measured) || !hasInterval(theory)) return null;
    const scale = (measured.end - measured.start) / (theory.end - theory.start);
    return validateTheoryMapping({ offset: measured.start - theory.start * scale, scale });
  }
  throw new UserError("Unknown theoretical profile alignment mode.");
}

/** Compose theory-to-measured and measured-to-view maps, in that order. */
export function mapTheoryToView(measuredMapping, theoryMapping) {
  if (!measuredMapping || !theoryMapping) return null;
  if (!Number.isFinite(measuredMapping.offset) || !Number.isFinite(measuredMapping.scale) || measuredMapping.scale <= 0)
    throw new UserError("Profile alignment must have a finite offset and a positive scale.");
  validateTheoryMapping(theoryMapping);
  return validateTheoryMapping({
    offset: measuredMapping.offset + theoryMapping.offset * measuredMapping.scale,
    scale: theoryMapping.scale * measuredMapping.scale,
  });
}

/** Measured minus theoretical values, weighted by common valid measured time.
 * Selection is restricted to both burn intervals; gaps are never interpolated
 * across and theory is never extrapolated outside its original CSV samples. */
export function comparisonToTheory(measuredData, measured, theoryData, theory, mapping) {
  if (!mapping || !hasInterval(measured) || !hasInterval(theory)) return null;
  validateTheoryMapping(mapping);
  const start = Math.max(measured.start, mapping.offset + theory.start * mapping.scale);
  const end = Math.min(measured.end, mapping.offset + theory.end * mapping.scale);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) return null;
  return compareProfiles(theoryData, mapping, measuredData, IDENTITY, { start, end });
}
