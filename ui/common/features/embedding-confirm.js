/**
 * The client half of the embedding-change confirmation.
 *
 * The rule itself lives on the server (`oss/server/src/embedding_change.rs`) and is
 * enforced on both write surfaces, so neither page here carries a copy of it. A page
 * just sends its save; if the server answers `428` with
 * `code = embedding_change_requires_confirmation`, this shows the exact transition the
 * server named and re-sends once with the flag set.
 *
 * Why the dialog is driven by the response and not by comparing form state: there are
 * three clients (UI, CLI, raw HTTP) and two write surfaces. A check that lives in a
 * dialog is a suggestion — the one that decides is behind the handler.
 */
import { confirmDialog } from '/common/design-system/app-modal/app-modal.js';

/** The slug the server returns. Must match `embedding_change::CODE`. */
const CODE = 'embedding_change_requires_confirmation';

/** Render one side of the transition the way the server described it. */
function describeTarget(target) {
  if (!target) return 'none';
  const { provider, model } = target;
  if (provider && model) return `${provider} · ${model}`;
  return provider || model || 'none';
}

/**
 * Run `send(confirmed)` and, on the server's 428, ask once and retry.
 *
 * A cancelled dialog rejects with `{ cancelled: true }` so callers can return quietly
 * instead of showing "Failed to save" for something the user chose not to do.
 *
 * @param {(confirmed: boolean) => Promise<any>} send
 * @returns {Promise<any>}
 */
export async function withEmbeddingConfirmation(send) {
  try {
    return await send(false);
  } catch (err) {
    if (err?.status !== 428 || err?.code !== CODE) throw err;
    const { from, to } = err.details ?? {};
    const confirmed = await confirmDialog({
      title: 'Change the embedding model?',
      message:
        `${err.message}\n\n`
        + `Now: ${describeTarget(from)}\n`
        + `After: ${describeTarget(to)}`,
      confirmLabel: 'Change anyway',
      danger: true,
    });
    if (!confirmed) throw { cancelled: true };
    return send(true);
  }
}
