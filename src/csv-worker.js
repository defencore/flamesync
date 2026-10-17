import { parseCSV, chartPoints } from "./data.js";
import { errorMessage } from "./messages.js";
self.onmessage = async ({ data: { file, settings } }) => {
  try {
    const data = parseCSV(await file.text(), settings);
    self.postMessage({ type: "done", data, reduced: chartPoints(data) });
  } catch (error) {
    self.postMessage({ type: "error", error: errorMessage(error) });
  }
};
