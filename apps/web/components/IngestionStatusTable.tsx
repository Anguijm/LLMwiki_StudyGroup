'use client';

// Real-time ingestion status table.
//
// Two pieces of correctness:
//
// (1) Reconnect race (r3 bug fix 3): while the initial re-fetch is in
//     flight, incoming websocket deltas are buffered in a Map keyed by
//     job id. When the fetch resolves, the snapshot is merged with the
//     queued deltas — for each id, the row with the newer updated_at wins.
//     Fresh deltas can't be overwritten by a stale fetch.
//
// (2) Channel cleanup (council batch-3-5 arch callout): useEffect cleanup
//     unsubscribes from the Realtime channel on unmount so re-mounts (e.g.
//     rapid reconnect, route changes) don't leak subscriptions.
//
// Screen-reader announcement (council a11y): a single aria-live region
// reports only terminal status transitions (completed / failed) once per
// job, debounced 1s.
import { useEffect, useRef, useState } from 'react';
import { supabaseBrowser } from '@llmwiki/db/browser';
import type { IngestionJob } from '@llmwiki/db/types';
import { classifyErrorKind } from '../lib/error-kind-classifier';
import { LocalizedDate } from './LocalizedDate';
import { t } from '../lib/i18n';

interface Props {
  initial: IngestionJob[];
}

type Row = Pick<IngestionJob, 'id' | 'status' | 'updated_at' | 'error' | 'started_at'>;

function newerOf(a: Row, b: Row): Row {
  return new Date(a.updated_at) >= new Date(b.updated_at) ? a : b;
}

export function IngestionStatusTable({ initial }: Props) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [liveMessage, setLiveMessage] = useState<string>('');
  const announcedRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<Map<string, Row>>(new Map());
  const fetchingRef = useRef<boolean>(false);

  useEffect(() => {
    const supabase = supabaseBrowser();
    const channel = supabase
      .channel('ingestion_jobs')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ingestion_jobs' },
        (payload) => {
          const rec = (payload.new ?? payload.old) as Row | null;
          if (!rec) return;
          if (fetchingRef.current) {
            const existing = queueRef.current.get(rec.id);
            queueRef.current.set(rec.id, existing ? newerOf(existing, rec) : rec);
            return;
          }
          applyDelta(rec);
          maybeAnnounce(rec);
        },
      )
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          fetchingRef.current = true;
          queueRef.current.clear();
          const { data } = await supabase
            .from('ingestion_jobs')
            .select('id,status,updated_at,error,started_at')
            .order('updated_at', { ascending: false })
            .limit(20);
          const snapshot: Row[] = (data as Row[] | null) ?? [];
          // Merge snapshot with any deltas that arrived during the fetch.
          const byId = new Map<string, Row>();
          for (const r of snapshot) byId.set(r.id, r);
          for (const [id, delta] of queueRef.current) {
            const existing = byId.get(id);
            byId.set(id, existing ? newerOf(existing, delta) : delta);
          }
          queueRef.current.clear();
          fetchingRef.current = false;
          setRows(Array.from(byId.values()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
        }
      });

    // CRITICAL: unsubscribe on unmount to prevent channel leaks.
    return () => {
      void channel.unsubscribe();
      void supabase.removeChannel(channel);
    };

    function applyDelta(rec: Row) {
      setRows((prev) => {
        const map = new Map(prev.map((r) => [r.id, r]));
        const existing = map.get(rec.id);
        map.set(rec.id, existing ? newerOf(existing, rec) : rec);
        return Array.from(map.values()).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      });
    }

    let announceTimer: ReturnType<typeof setTimeout> | null = null;
    function maybeAnnounce(rec: Row) {
      if (rec.status !== 'completed' && rec.status !== 'failed') return;
      if (announcedRef.current.has(rec.id)) return;
      announcedRef.current.add(rec.id);
      if (announceTimer) clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        setLiveMessage(rec.status === 'completed' ? t('status.completed') : t('status.failed'));
      }, 1000);
    }
  }, []);

  return (
    <section aria-labelledby="status-heading" className="mt-8">
      <h2 id="status-heading" className="text-lg font-semibold text-brand-900 mb-4">
        {t('dashboard.status.heading')}
      </h2>
      {rows.length === 0 ? (
        <p className="text-brand-700">{t('dashboard.status.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="border border-brand-100 rounded-md p-3 flex justify-between">
              <span className="flex items-center gap-2">
                <StatusPill row={r} />
                <span className="text-sm text-brand-700">
                  <LocalizedDate iso={r.updated_at} mode="relative" />
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Single aria-live region; only terminal state changes announce. */}
      <div role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </div>
    </section>
  );
}

function StatusPill({ row }: { row: Row }) {
  const cat = row.error ? classifyErrorKind(row.error.kind) : null;
  const className =
    row.status === 'completed'
      ? 'bg-success text-white'
      : row.status === 'failed' && cat === 'user_correctable'
        ? 'bg-warning text-white'
        : row.status === 'failed'
          ? 'bg-danger text-white'
          : 'bg-brand-100 text-brand-900';
  return (
    <span className={`px-2 py-1 text-xs rounded-md ${className}`}>
      {row.status === 'completed'
        ? t('status.completed')
        : row.status === 'failed'
          ? t('status.failed')
          : row.status === 'running'
            ? t('status.running')
            : t('status.queued')}
    </span>
  );
}
