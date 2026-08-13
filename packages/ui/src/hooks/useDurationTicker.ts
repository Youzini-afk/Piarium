import React from 'react';

type Subscriber = (now: number) => void;

interface TickerChannel {
  subscribers: Set<Subscriber>;
  timerId: number | null;
}

const tickerChannels = new Map<number, TickerChannel>();

const subscribeToTicker = (intervalMs: number, subscriber: Subscriber): (() => void) => {
  let channel = tickerChannels.get(intervalMs);
  if (!channel) {
    channel = { subscribers: new Set(), timerId: null };
    tickerChannels.set(intervalMs, channel);
  }

  channel.subscribers.add(subscriber);
  subscriber(Date.now());
  if (channel.timerId === null && typeof window !== 'undefined') {
    channel.timerId = window.setInterval(() => {
      const now = Date.now();
      channel?.subscribers.forEach((listener) => listener(now));
    }, intervalMs);
  }

  return () => {
    const tracked = tickerChannels.get(intervalMs);
    if (!tracked) return;
    tracked.subscribers.delete(subscriber);
    if (tracked.subscribers.size > 0) return;
    if (tracked.timerId !== null && typeof window !== 'undefined') {
      window.clearInterval(tracked.timerId);
    }
    tickerChannels.delete(intervalMs);
  };
};

export const useDurationTickerNow = (active: boolean, intervalMs = 1_000): number => {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!active) return;
    return subscribeToTicker(intervalMs, setNow);
  }, [active, intervalMs]);

  return now;
};
