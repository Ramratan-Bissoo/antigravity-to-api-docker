// Load this project's .env before modules read process.env. No external package needed.
import { loadEnvFile } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dotenvFile = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
try {
  loadEnvFile(dotenvFile);
} catch (loadProblem) {
  // Let the app use its built-in defaults when .env has not been created yet.
  if (loadProblem.code !== "ENOENT") throw loadProblem;
}
