import { once } from "node:events";
import type { Channel } from "amqplib";
import type { ScompFeedChunkEnvelope, ScompSerializer } from "@scomp/types";
import type { RunningFeed } from "./types";

export async function waitForChannelDrainIfNeeded(channel: Channel): Promise<void> {
  const writable = (channel as unknown as { writable?: boolean }).writable;
  if (writable === false) {
    await once(channel, "drain");
  }
}

export async function publishFeed(
  channel: Channel,
  runningFeed: RunningFeed,
  iterable: AsyncIterable<unknown>,
  serializer: ScompSerializer,
  contentType: string,
  onComplete: (feed: RunningFeed) => void,
): Promise<void> {
  const serializeToBuffer = (value: unknown): Buffer => Buffer.from(serializer.stringify(value));

  try {
    for await (const chunk of iterable) {
      if (runningFeed.abortController.signal.aborted) {
        throw runningFeed.abortController.signal.reason;
      }

      channel.publish(
        runningFeed.exchange,
        "",
        serializeToBuffer({
          channel: "feed",
          feed: runningFeed.key,
          type: "next",
          payload: chunk,
        } satisfies ScompFeedChunkEnvelope),
        {
          contentType,
          mandatory: true,
        },
      );
      await waitForChannelDrainIfNeeded(channel);
    }

    channel.publish(
      runningFeed.exchange,
      "",
      serializeToBuffer({
        channel: "feed",
        feed: runningFeed.key,
        type: "done",
      } satisfies ScompFeedChunkEnvelope),
      {
        contentType,
        mandatory: true,
      },
    );
    await waitForChannelDrainIfNeeded(channel);
  } catch (error) {
    channel.publish(
      runningFeed.exchange,
      "",
      serializeToBuffer({
        channel: "feed",
        feed: runningFeed.key,
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      } satisfies ScompFeedChunkEnvelope),
      {
        contentType,
        mandatory: true,
      },
    );
    await waitForChannelDrainIfNeeded(channel);
  } finally {
    onComplete(runningFeed);
  }
}
