#!/usr/bin/env node
/**
 * `dsh channels verify` — offline adapter verification CLI (Task 17.3).
 *
 * Usage:
 *   node lib/cli.js [dir] [--test] [--allow-unsupported]
 *
 *   dir                 adapter package directory (default '.')
 *   --test              run the adapter's own test suite (pnpm test) as the
 *                       contract check
 *   --allow-unsupported treat an 'unsupported' compatibility state as a
 *                       warning instead of a failure
 *
 * Exit code: 0 when the report has no 'fail' items, 1 otherwise (warnings do
 * not fail the run).
 */
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  verifyAdapter,
  type VerifyReport,
  type VerifySeverity,
} from './verify.js';

export interface CliOptions {
  dir: string;
  test: boolean;
  allowUnsupported: boolean;
}

/** Hand-rolled argument parsing (no CLI dependency). */
export function parseArgs(argv: string[]): CliOptions {
  let dir: string | undefined;
  let test = false;
  let allowUnsupported = false;
  for (const arg of argv) {
    if (arg === '--test') {
      test = true;
    } else if (arg === '--allow-unsupported') {
      allowUnsupported = true;
    } else if (arg.startsWith('-')) {
      // Unknown flag: ignore so future flags stay backward compatible.
    } else if (dir === undefined) {
      dir = arg;
    }
  }
  return { dir: dir ?? '.', test, allowUnsupported };
}

/**
 * Resolve the adapter directory. Relative paths are resolved against the
 * directory the user invoked pnpm from (`INIT_CWD`), because pnpm runs
 * package scripts with the package directory as cwd.
 */
function resolveDir(dir: string): string {
  if (isAbsolute(dir)) return dir;
  const base = process.env.INIT_CWD ?? process.cwd();
  return resolve(base, dir);
}

function badge(severity: VerifySeverity): string {
  switch (severity) {
    case 'ok':
      return '[ok]   ';
    case 'warning':
      return '[warn] ';
    case 'fail':
      return '[FAIL] ';
  }
}

/** Format a verify report for the terminal. */
export function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push(`verify: ${report.dir}`);
  for (const check of report.checks) {
    for (const item of check.items) {
      lines.push(`${badge(item.severity)} ${check.id.padEnd(15)} ${item.code} — ${item.message}`);
    }
  }
  lines.push('');
  lines.push(
    `summary: ${report.summary.ok} ok, ${report.summary.warning} warning(s), ${report.summary.fail} fail(s)`,
  );
  lines.push(`result: ${report.passed ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

/**
 * Run the verify CLI. Returns the process exit code (0 = pass, 1 = fail).
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  const dir = resolveDir(options.dir);
  const report = await verifyAdapter(dir, {
    test: options.test,
    allowUnsupported: options.allowUnsupported,
  });
  console.log(formatReport(report));
  return report.passed ? 0 : 1;
}

// Run only when executed directly (not when imported by tests or the lib).
const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[channel-verify] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
