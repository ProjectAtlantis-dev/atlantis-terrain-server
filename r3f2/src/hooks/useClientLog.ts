import { useRef, useCallback, useEffect } from 'react';
import {
  CLIENT_LOG_ENABLED,
  CLIENT_LOG_ENDPOINT,
  CLIENT_LOG_BATCH_SIZE,
  CLIENT_LOG_MAX_QUEUE,
  CLIENT_LOG_FLUSH_MS,
} from '@/utils/constants';

interface LogEntry {
  ts: string;
  level: string;
  phase: string;
  details?: unknown;
}

/**
 * Client logging hook — batches log entries and POSTs them to the Flask server.
 */
export function useClientLog() {
  const queueRef = useRef<LogEntry[]>([]);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(
    ({ useBeacon = false }: { useBeacon?: boolean } = {}) => {
      if (!CLIENT_LOG_ENABLED || inFlightRef.current || queueRef.current.length === 0)
        return;

      const batch = queueRef.current.splice(0, CLIENT_LOG_BATCH_SIZE);
      const body = JSON.stringify({
        sceneMode: 'atlantis-r3f2',
        entries: batch,
      });

      if (useBeacon && navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        const ok = navigator.sendBeacon(CLIENT_LOG_ENDPOINT, blob);
        if (!ok) queueRef.current.unshift(...batch);
        return;
      }

      inFlightRef.current = true;
      fetch(CLIENT_LOG_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      })
        .then((res) => {
          if (!res.ok) throw new Error(`status ${res.status}`);
        })
        .catch(() => {
          queueRef.current.unshift(...batch);
          if (queueRef.current.length > CLIENT_LOG_MAX_QUEUE) {
            queueRef.current.splice(0, queueRef.current.length - CLIENT_LOG_MAX_QUEUE);
          }
        })
        .finally(() => {
          inFlightRef.current = false;
          if (queueRef.current.length > 0) scheduleFlush(250);
        });
    },
    []
  );

  const scheduleFlush = useCallback(
    (delayMs = CLIENT_LOG_FLUSH_MS) => {
      if (!CLIENT_LOG_ENABLED || timerRef.current != null) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush();
      }, delayMs);
    },
    [flush]
  );

  const log = useCallback(
    (level: string, phase: string, details?: unknown) => {
      if (!CLIENT_LOG_ENABLED) return;
      const entry: LogEntry = { ts: new Date().toISOString(), level, phase };
      if (details !== undefined) {
        try {
          entry.details = JSON.parse(JSON.stringify(details));
        } catch {
          entry.details = { nonSerializable: true };
        }
      }
      queueRef.current.push(entry);
      if (queueRef.current.length > CLIENT_LOG_MAX_QUEUE) {
        queueRef.current.splice(0, queueRef.current.length - CLIENT_LOG_MAX_QUEUE);
      }
      if (queueRef.current.length >= CLIENT_LOG_BATCH_SIZE) {
        flush();
      } else {
        scheduleFlush();
      }
    },
    [flush, scheduleFlush]
  );

  const bootLog = useCallback(
    (phase: string, details?: unknown, level = 'info') => {
      log(level, phase, details);
    },
    [log]
  );

  // Flush on unload
  useEffect(() => {
    const handler = () => flush({ useBeacon: true });
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [flush]);

  return { log, bootLog, flush };
}
