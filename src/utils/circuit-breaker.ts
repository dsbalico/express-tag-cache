/**
 * Consecutive-failure circuit breaker. Closed: every call goes through. Open: calls are refused
 * until the cooldown ends. Then one probe call is let through; its outcome closes or reopens it.
 */
export class CircuitBreaker {
	private failures = 0;
	private openUntil = 0;
	private probing = false;

	constructor(
		private readonly failureThreshold: number,
		private readonly cooldownMs: number,
		private readonly onChange: (state: 'open' | 'closed') => void,
	) {}

	/** Whether a call may go through now. Grants at most one probe once the cooldown has ended. */
	allow(now = Date.now()): boolean {
		if (this.openUntil === 0) return true;
		if (now < this.openUntil || this.probing) return false;
		this.probing = true;
		return true;
	}

	success(): void {
		const wasOpen = this.openUntil !== 0;
		this.failures = 0;
		this.openUntil = 0;
		this.probing = false;
		if (wasOpen) this.onChange('closed');
	}

	/** Ends a call that says nothing about Redis' health (e.g. invalid input): frees the probe slot, changes nothing else. */
	release(): void {
		this.probing = false;
	}

	failure(now = Date.now()): void {
		this.failures++;
		const wasOpen = this.openUntil !== 0;
		if (this.probing || this.failures >= this.failureThreshold) {
			this.openUntil = now + this.cooldownMs;
			this.probing = false;
			if (!wasOpen) this.onChange('open');
		}
	}
}
