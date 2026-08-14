/**
 * TypingController — best-effort typing indicator (WX6-grade).
 *
 * Calls `client.sendTyping` when enabled; failures NEVER fail the main
 * message. Tracks active/stopped so a turn that ends cancels the indicator.
 */
import type { ILinkClient } from '../ilink/client.js';
import { TYPING_STATUS_CANCEL, TYPING_STATUS_TYPING } from '../ilink/types.js';

export interface TypingControllerOptions {
  client: ILinkClient;
  /** Whether typing is enabled (from config). */
  enabled?: boolean;
  /** Optional typing ticket for the conversation. */
  typingTicket?: string | (() => Promise<string | undefined> | string | undefined);
}

export class TypingController {
  private readonly client: ILinkClient;
  private readonly enabled: boolean;
  private readonly typingTicket?: TypingControllerOptions['typingTicket'];
  private active = false;

  constructor(options: TypingControllerOptions) {
    this.client = options.client;
    this.enabled = options.enabled ?? false;
    this.typingTicket = options.typingTicket;
  }

  get isActive(): boolean {
    return this.active;
  }

  private async resolveTicket(): Promise<string | undefined> {
    if (this.typingTicket === undefined) return undefined;
    return typeof this.typingTicket === 'function' ? this.typingTicket() : this.typingTicket;
  }

  /** Start the typing indicator for a user. */
  async start(to: string): Promise<void> {
    if (!this.enabled) return;
    this.active = true;
    try {
      const ticket = await this.resolveTicket();
      await this.client.sendTyping({
        ilink_user_id: to,
        typing_ticket: ticket,
        status: TYPING_STATUS_TYPING,
      });
    } catch {
      // best effort — typing must never break the main flow.
      this.active = false;
    }
  }

  /** Cancel the typing indicator for a user. */
  async stop(to: string): Promise<void> {
    if (!this.enabled) return;
    this.active = false;
    try {
      const ticket = await this.resolveTicket();
      await this.client.sendTyping({
        ilink_user_id: to,
        typing_ticket: ticket,
        status: TYPING_STATUS_CANCEL,
      });
    } catch {
      // best effort
    }
  }
}
