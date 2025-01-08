/**
 * Is thrown if the transactionTimeoutMs is exceeded
 */
import { ErrorWithCause } from '../utils/error-with-cause';

export class TransactionTimeoutError extends Error {
    readonly timeoutMs: number | undefined;

    constructor({ timeoutMs }: { readonly timeoutMs?: number } = {}) {
        super(
            `Transaction exceeded timeout${
                timeoutMs ? ' of ' + timeoutMs : ''
            } and was rolled back`,
        );
        this.name = this.constructor.name;
        this.timeoutMs = timeoutMs;
    }
}

/**
 * Is thrown if a transaction is cancelled via the cancellation token before it completed
 */
export class TransactionCancelledError extends Error {
    constructor(message = `Transaction was cancelled and has been rolled back`) {
        super(message);
        this.name = this.constructor.name;
    }
}

export class ConflictRetriesExhaustedError extends ErrorWithCause {
    static readonly CODE = 'CONFLICT_RETRIES_EXHAUSTED';

    readonly code = ConflictRetriesExhaustedError.CODE;

    constructor({ causedBy, retries }: { causedBy: unknown; retries: number }) {
        super(`Operation detected conflicts and was aborted after ${retries} retries`, {
            causedBy,
        });
    }
}
