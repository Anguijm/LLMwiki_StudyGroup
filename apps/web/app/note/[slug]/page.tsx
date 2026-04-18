import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { supabaseForRequest, supabaseService } from '../../../lib/supabase';
import { LocalizedDate } from '../../../components/LocalizedDate';

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function NotePage({ params }: Props) {
  const { slug } = await params;
  const rls = await supabaseForRequest();

  const { data: note } = await rls
    .from('notes')
    .select('id, slug, title, body_md, tier, created_at, cohort_id')
    .eq('slug', slug)
    .single();

  if (!note) notFound();

  // Record a view (user-scoped; per-day uniqueness enforced by upsert
  // onConflict). Powers notes.view.count → user-centric kill criterion.
  const { data: { user } } = await rls.auth.getUser();
  if (user) {
    const svc = supabaseService();
    await svc.from('note_views').upsert(
      { note_id: note.id, user_id: user.id, view_count: 1 },
      { onConflict: 'note_id,user_id,viewed_day', ignoreDuplicates: false },
    );
  }

  return (
    <article>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-brand-900">{note.title}</h1>
        <p className="text-sm text-brand-700">
          <span className="mr-2">Tier: {note.tier}</span>
          <LocalizedDate iso={note.created_at} />
        </p>
      </header>

      <div className="prose prose-slate max-w-none">
        {/* rehype-sanitize applies the default schema — disallows <script>,
            <iframe>, <style>, on*= handlers, and any unknown tag. r5
            security nice-to-have confirmation. */}
        <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{note.body_md}</ReactMarkdown>
      </div>

      {/* "Related notes" powered by getContext lands in a follow-up slice;
          v0 ships the empty-state placeholder so the UI surface is visible
          and the layout is stable. */}
      <section aria-labelledby="related-heading" className="mt-10">
        <h2 id="related-heading" className="text-lg font-semibold text-brand-900">
          Related notes
        </h2>
        <p className="text-brand-700 text-sm">
          Related notes appear here as the knowledge base grows.
        </p>
      </section>
    </article>
  );
}
