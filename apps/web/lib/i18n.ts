// Minimal i18n seam. v0 ships English-only; every user-facing string goes
// through t() so v1 can point it at real locale files without touching
// component code.

type Key =
  | 'app.name'
  | 'dashboard.notes.heading'
  | 'dashboard.notes.empty'
  | 'dashboard.upload.button'
  | 'dashboard.upload.pending'
  | 'dashboard.status.heading'
  | 'dashboard.status.empty'
  | 'status.queued'
  | 'status.running'
  | 'status.completed'
  | 'status.failed'
  | 'status.cancelled'
  | 'error.generic'
  | 'error.cohort_missing'
  | 'error.file_too_large'
  | 'error.rate_limit'
  | 'error.token_budget_exhausted'
  | 'error.system_transient'
  | 'error.user_correctable'
  | 'review.heading'
  | 'review.empty'
  | 'review.show_answer'
  | 'review.hide_answer'
  | 'review.next_card'
  | 'review.load_error'
  | 'review.render_error';

const STRINGS: Record<Key, string> = {
  'app.name': 'LLM Wiki · Study Group',
  'dashboard.notes.heading': 'Your notes',
  'dashboard.notes.empty': 'No notes yet. Upload a PDF to get started.',
  'dashboard.upload.button': 'Upload PDF',
  'dashboard.upload.pending': 'Uploading…',
  'dashboard.status.heading': 'Recent ingestion jobs',
  'dashboard.status.empty': 'No recent jobs.',
  'status.queued': 'Queued',
  'status.running': 'Processing',
  'status.completed': 'Ready',
  'status.failed': 'Failed',
  'status.cancelled': 'Cancelled',
  'error.generic': 'Something went wrong.',
  'error.cohort_missing':
    'Cohort membership could not be created. Contact your cohort admin.',
  'error.file_too_large': 'That file is too large. Max 25 MB.',
  'error.rate_limit': 'Too many uploads in the last hour. Try again later.',
  'error.token_budget_exhausted': 'Token budget exhausted.',
  'error.system_transient': 'Service temporarily unavailable.',
  'error.user_correctable': 'We could not process that file.',
  'review.heading': 'Review',
  'review.empty': 'No flashcards yet. Upload a PDF to generate flashcards.',
  'review.show_answer': 'Show answer',
  'review.hide_answer': 'Hide answer',
  'review.next_card': 'Next card',
  'review.load_error': "Couldn't load your flashcards. Please refresh in a moment.",
  'review.render_error':
    "Something went wrong rendering this card. Refresh to try again.",
};

export function t(key: Key): string {
  return STRINGS[key];
}
