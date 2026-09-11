/**
 * Channel-side human interactions.
 *
 * `QuestionInteraction*` today; the directory and interface naming leave
 * room for an `ApprovalInteraction` sibling (future) without sharing
 * interfaces prematurely — the official question/approval domains compose
 * answerers on the same Cordis waterfall mechanism.
 */
export * from './question-backend.js';
export * from './question-presenter.js';
export * from './question-state.js';
export * from './question-waterfall-backend.js';
