const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function graphemes(value) {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

// Measure complete candidates so kerning and proportional glyph widths count.
function fittingPrefix(ctx, parts, width, suffix = "") {
  if (ctx.measureText(suffix).width > width) return "";
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = parts.slice(0, middle).join("") + suffix;
    if (ctx.measureText(candidate).width <= width) low = middle;
    else high = middle - 1;
  }
  return parts.slice(0, low).join("") + suffix;
}

/**
 * Wrap text in the current canvas font without splitting grapheme clusters.
 * Explicit newlines are retained; content beyond maxLines ends in an ellipsis.
 */
export function textLines(ctx, value, width, maxLines = 2) {
  const text = String(value ?? "");
  const limit = Math.floor(maxLines);
  if (!text || !(width > 0) || !(limit > 0)) return [];
  if (!/[\r\n]/.test(text)) {
    const normalized = text.trim().replace(/\s+/g, " ");
    if (ctx.measureText(normalized).width <= width) return [normalized];
  }
  const paragraphs = text.split(/\r\n?|\n/);
  const result = [];
  const clipped = () => {
    const last = result.length - 1;
    if (last < 0) result.push("");
    const index = Math.max(0, last);
    result[index] = fittingPrefix(
      ctx,
      graphemes(result[index].trimEnd()),
      width,
      "…",
    );
    return result;
  };

  for (let paragraph = 0; paragraph < paragraphs.length; paragraph++) {
    const words = paragraphs[paragraph].trim().split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= width) {
        line = candidate;
        continue;
      }
      if (line) {
        result.push(line);
        if (result.length === limit) return clipped();
        line = "";
      }

      let remaining = graphemes(word);
      while (remaining.length) {
        const rest = remaining.join("");
        if (ctx.measureText(rest).width <= width) {
          line = rest;
          break;
        }
        const part = fittingPrefix(ctx, remaining, width);
        if (!part) {
          result.push("");
          return clipped();
        }
        result.push(part);
        if (result.length === limit) return clipped();
        remaining = remaining.slice(graphemes(part).length);
      }
    }
    result.push(line);
    if (result.length === limit && paragraph < paragraphs.length - 1)
      return clipped();
  }
  return result;
}

/**
 * Fit a filename in the current canvas font with a measured middle ellipsis.
 * Keep its complete extension whenever the ellipsis and extension fit.
 */
export function filenameLabel(ctx, value, width) {
  const text = String(value ?? "").replace(/\r\n?|\n/g, " ");
  if (!(width > 0)) return "";
  if (ctx.measureText(text).width <= width) return text;
  if (ctx.measureText("…").width > width) return "";
  const parts = graphemes(text);
  const dot = text.lastIndexOf(".");
  const extension = dot > 0 ? text.slice(dot) : "";
  const minimumSuffix =
    extension && ctx.measureText(`…${extension}`).width <= width
      ? graphemes(extension).length
      : 0;
  const candidateAt = (count) => {
    const suffix = Math.max(minimumSuffix, Math.ceil(count * 0.4));
    const prefix = count - suffix;
    return (
      parts.slice(0, prefix).join("") +
      "…" +
      (suffix ? parts.slice(-suffix).join("") : "")
    );
  };
  let low = minimumSuffix;
  let high = Math.max(low, parts.length - 1);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (ctx.measureText(candidateAt(middle)).width <= width) low = middle;
    else high = middle - 1;
  }
  return candidateAt(low);
}
