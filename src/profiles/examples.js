// Synthetic examples are generated in memory only when explicitly requested.
export function profileExamples() {
  return [0, 1].map((variant) => {
    const rate = variant ? 120 : 50, offset = variant ? 10 : 0;
    const unit = variant ? "us" : "ms", factor = variant ? 1e6 : 1e3;
    const rows = [`time_${unit};thrust;pressure`];
    for (let index = 0; index <= rate * 5; index++) {
      const time = index / rate, phase = (time - 0.8) / (variant ? 2.8 : 2.5);
      const envelope = phase > 0 && phase < 1 ? Math.min(1, phase * 12, (1 - phase) * 12) : 0;
      const force = envelope * ((variant ? 105 : 100) + (variant ? 2 : 0.7) * Math.sin(time * 98));
      rows.push(`${Math.round((time + offset) * factor)};${force.toFixed(5)};${(force / 50).toFixed(5)}`);
    }
    return new File([rows.join("\n")], `Example-${variant ? "B-120Hz" : "A-50Hz"}.csv`, { type: "text/csv" });
  });
}

export function seriesExamples() {
  return [50, 120, 80, 100, 60].map((rate, index) => {
    const unit = index % 2 ? "us" : "ms", factor = unit === "us" ? 1e6 : 1e3;
    const rows = [`time_${unit};thrust;pressure`], duration = 2.5 + index * .015;
    for (let sample = 0; sample <= rate * 5; sample++) {
      const time = sample / rate, phase = (time - .8) / duration;
      const envelope = phase > 0 && phase < 1 ? Math.min(1, phase * 12, (1 - phase) * 12) : 0;
      const force = envelope * ((index === 4 ? 120 : 99 + index) + Math.sin(time * (35 + index * 4)));
      rows.push(`${Math.round((time + index * 10) * factor)};${force.toFixed(5)};${(force / 50).toFixed(5)}`);
    }
    return new File([rows.join("\n")], `Series-example-${String(index + 1).padStart(2, "0")}.csv`, { type: "text/csv" });
  });
}
