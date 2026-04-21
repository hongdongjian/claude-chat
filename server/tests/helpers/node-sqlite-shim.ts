// Shim used only in tests. Vite 5's module resolver doesn't know about
// Node 22's `node:sqlite` built-in and strips the `node:` prefix, failing
// the import. Loading via createRequire keeps it out of Vite's static graph.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mod = require("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync = mod.DatabaseSync;
export default mod;
