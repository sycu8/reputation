import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["apps", "workers", "packages", "types"];
const failures = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if ([".ts", ".d.ts"].includes(extname(path)) || path.endsWith(".d.ts")) {
      const text = await readFile(path, "utf8");
      if (/\t/.test(text)) failures.push(`${path}: tabs are not allowed`);
      if (/[ \t]+$/m.test(text)) failures.push(`${path}: trailing whitespace`);
      if (/999999999/.test(text)) failures.push(`${path}: fake unlimited quota constant`);
      if (/console\.log\([^)]*(password|secret|token)/i.test(text)) failures.push(`${path}: possible secret logging`);
    }
  }
}

for (const root of roots) await walk(root);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("lint: baseline checks passed");
