/**
 * Fake channel app — M0 end-to-end proof.
 *
 * Wires a fake adapter into a Cordis runtime and connects it to the
 * channel-harness bridge port so the full loop
 * (ChannelEvent → SessionBinding → AgentRouter → reply pipeline) can run
 * without any real platform or Harness runtime.
 */
import { ChannelService } from '@dsh/channel-core';

export { ChannelService };
