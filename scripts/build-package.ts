import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const output = resolve(root, "dist/livespace-crm-mcp");

await mkdir(dirname(output), { recursive: true });
try {
  await unlink(output);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const result = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: dirname(output),
  naming: "livespace-crm-mcp",
  target: "bun",
  format: "esm",
  minify: false,
  sourcemap: "none",
  banner: "#!/usr/bin/env bun",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Package build failed.");
}

const text = await Bun.file(output).text();
if (!text.startsWith("#!/usr/bin/env bun\n")) {
  throw new Error("Package bin is missing the Bun shebang.");
}
if (/(?:from|import\()\s*["'][^"']*src\//u.test(text)) {
  throw new Error("Package bin still imports from the source tree.");
}

await chmod(output, 0o755);
console.log(`Built ${output}`);
