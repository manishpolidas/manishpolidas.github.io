import { useEffect, useRef, useState } from 'react';
import type { RealtimeEvent } from './types';

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * Subscribes to the server's WebSocket feed with automatic reconnect.
 *
 * The handler is kept in a ref so re-renders never tear down the socket.
 */
export function useRealtime(
  enabled: boolean,
  onEvent: (event: RealtimeEvent) => void,
): ConnectionState {
  const [state, setState] = useState<ConnectionState>('closed');
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!enabled) {
      setState('closed');
      return;
    }

    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let attempt = 0;
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      setState('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

      socket.onopen = () => {
        attempt = 0;
        setState('open');
      };
      socket.onmessage = (event) => {
        try {
          handlerRef.current(JSON.parse(String(event.data)) as RealtimeEvent);
        } catch {
          // Ignore frames we cannot parse rather than killing the stream.
        }
      };
      socket.onclose = () => {
        setState('closed');
        if (disposed) return;
        attempt += 1;
        const backoff = Math.min(10_000, 500 * 2 ** Math.min(attempt, 4));
        retry = window.setTimeout(connect, backoff);
      };
      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retry) window.clearTimeout(retry);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [enabled]);

  return state;
}
