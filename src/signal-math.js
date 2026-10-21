// Exact positive area under a linear sensor segment, including zero crossings.
export function positiveArea(a, b, duration) {
  if (a >= 0 && b >= 0) return (a / 2 + b / 2) * duration;
  if (a <= 0 && b <= 0) return 0;
  const positive = Math.max(a, b), negative = -Math.min(a, b);
  const fraction = positive >= negative ? 1 / (1 + negative / positive)
    : (positive / negative) / (1 + positive / negative);
  return (positive / 2) * (duration * fraction);
}
