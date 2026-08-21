/**
 * Channel-side human interactions (upgrade plan §5 / §19 / §21 P0-3).
 *
 * `QuestionInteraction*` today; the directory and interface naming leave
 * room for an `ApprovalInteraction` sibling (plan P1-3) without sharing
 * interfaces prematurely — the official mux already carries
 * `approval/requested` / `approval/resolved` frames.
 */
export * from './question-backend.js';
export * from './question-presenter.js';
export * from './question-state.js';
export * from './question-apiproxy-backend.js';
export * from './question-direct-backend.js';
