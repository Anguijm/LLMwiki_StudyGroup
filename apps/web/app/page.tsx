import { redirect } from 'next/navigation';
import { supabaseForRequest, supabaseService } from '../lib/supabase';
import { UploadButton } from '../components/UploadButton';
import { IngestionStatusTable } from '../components/IngestionStatusTable';
import { LocalizedDate } from '../components/LocalizedDate';
import { t } from '../lib/i18n';
import type { IngestionJob, Note } from '@llmwiki/db/types';

const DEFAULT_COHORT_ID = '00000000-0000-0000-0000-000000000001';

export default async function Dashboard() {
  const rls = await supabaseForRequest();
  const { data: { user } } = await rls.auth.getUser();
  if (!user) redirect('/auth');

  // Post-login cohort upsert (r1 council bugs fix — typed error on failure).
  const svc = supabaseService();
  const { error: upsertErr } = await svc
    .from('cohort_members')
    .upsert({ cohort_id: DEFAULT_COHORT_ID, user_id: user.id, role: 'member' }, { onConflict: 'cohort_id,user_id' });
  if (upsertErr) {
    return (
      <div role="alert" className="p-4 border border-danger bg-white rounded-md">
        <h2 className="text-lg font-semibold">{t('error.cohort_missing')}</h2>
      </div>
    );
  }

  // Notes (server-component read, RLS enforced via the user's JWT).
  const { data: notes } = await rls
    .from('notes')
    .select('id, slug, title, created_at, tier')
    .order('created_at', { ascending: false })
    .limit(20);

  // Initial ingestion jobs snapshot (re-fetched by the Realtime component).
  const { data: jobs } = await rls
    .from('ingestion_jobs')
    .select('id, status, updated_at, error, started_at')
    .order('updated_at', { ascending: false })
    .limit(20);

  const notesList: Pick<Note, 'id' | 'slug' | 'title' | 'created_at' | 'tier'>[] = (notes ?? []) as [];
  const jobsList: IngestionJob[] = (jobs ?? []) as unknown as IngestionJob[];

  return (
    <div>
      <section aria-labelledby="upload-heading" className="mb-8">
        <h2 id="upload-heading" className="text-lg font-semibold mb-2">
          {t('dashboard.upload.button')}
        </h2>
        <UploadButton cohortId={DEFAULT_COHORT_ID} />
      </section>

      <section aria-labelledby="notes-heading">
        <h2 id="notes-heading" className="text-lg font-semibold mb-4">
          {t('dashboard.notes.heading')}
        </h2>
        {notesList.length === 0 ? (
          <p className="text-brand-700">{t('dashboard.notes.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {notesList.map((n) => (
              <li key={n.id} className="border border-brand-100 rounded-md p-3">
                <a href={`/note/${n.slug}`} className="font-medium text-brand-900 underline">
                  {n.title}
                </a>
                <span className="block text-sm text-brand-700">
                  <LocalizedDate iso={n.created_at} mode="relative" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <IngestionStatusTable initial={jobsList} />
    </div>
  );
}
