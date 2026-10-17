import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? files(join(directory, entry.name))
          : join(directory, entry.name),
      ),
    )
  ).flat();
}

const entries = (await files("dist")).map((path) => relative("dist", path));
const prohibited = entries.filter(
  (path) =>
    /\.(csv|tsv|mp4|webm|mov|mkv|avi|wav|mp3)$/i.test(path) ||
    /(^|\/)(screenshots|test-results|tests|fixtures)(\/|$)/i.test(path),
);
if (prohibited.length)
  throw new Error(
    `Deployment must not include source logs or generated test media: ${prohibited.join(", ")}`,
  );
console.log(
  `Verified ${entries.length} static assets. No CSV logs, test directories, or generated test media in deployment.`,
);
