import { runUniversalChecks } from "./precommit-checks.mjs";

const errors = runUniversalChecks();
if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}
