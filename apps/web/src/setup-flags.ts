/**
 * Client-side flags for the first-run checklist (#83), kept in localStorage.
 *
 *  - `dismissed`   the operator chose to leave /setup; it stops being the default
 *                  route even while items are incomplete. /setup has no nav item: the
 *                  way back is the "Setup isn't finished" notice on New task and Settings,
 *                  or Settings → Guided setup.
 *  - `pipelineReviewed`  the optional "review your pipeline" item auto-✓s once the
 *                  operator has visited /pipeline or dispatched a run.
 *
 * localStorage can throw (private mode, disabled storage); every access is guarded
 * so the checklist degrades to "not flagged" rather than crashing the view.
 */
const DISMISSED = 'asf.setup.dismissed';
const PIPELINE_REVIEWED = 'asf.setup.pipelineReviewed';

function get(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function set(key: string): void {
  try { localStorage.setItem(key, '1'); } catch { /* storage unavailable — ignore */ }
}

export const setupFlags = {
  isDismissed: () => get(DISMISSED),
  dismiss: () => set(DISMISSED),
  isPipelineReviewed: () => get(PIPELINE_REVIEWED),
  markPipelineReviewed: () => set(PIPELINE_REVIEWED),
};
