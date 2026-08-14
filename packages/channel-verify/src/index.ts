/**
 * @wsz987/channel-verify — offline verification for third-party channel adapters
 * (Task 17.3, `dsh channels verify`).
 *
 * A dependency-light library surface plus a zero-dependency CLI. `verifyAdapter`
 * runs all checks in-process (package, adapter surface, manifest, capabilities,
 * fixtures, credentials, contract) and works offline for CI.
 */
export {
  verifyAdapter,
  type VerifyCheck,
  type VerifyItem,
  type VerifyOptions,
  type VerifyReport,
  type VerifySeverity,
  type VerifySummary,
} from './verify.js';
export { formatReport, main, parseArgs, type CliOptions } from './cli.js';
