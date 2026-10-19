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
