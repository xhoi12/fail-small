import { useEffect, useRef } from "react";

const SEEN_KEY = "fail-small-seen-help";

/** The rules. Opens by itself on the first visit, and from "How to play" in the top bar. */
export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) {
        localStorage.setItem(SEEN_KEY, "1");
        onOpenChange(true);
      }
    } catch {}
  }, [onOpenChange]);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog ref={dialog} className="help" aria-labelledby="help-title" onClose={() => onOpenChange(false)}>
      <form method="dialog">
        <h2 id="help-title">How to play</h2>
        <p className="muted">
          You're the release engineer. Each level is a config change that may or may not be broken. Get it to the whole
          fleet if it's good, or roll it back if it's bad, while hurting as few requests as possible.
        </p>
        <ol className="help-steps">
          <li>
            <b>Review.</b> Read the ticket and the config diff. The co-pilot on the right posts a pre-flight review.
          </li>
          <li>
            <b>Plan.</b> Choose a strategy (big bang, fast or staged), a canary datacenter that gets the change first,
            and how long each stage bakes.
          </li>
          <li>
            <b>Deploy and watch.</b> Each stage applies the config, bakes, then runs a health check. If any datacenter
            goes over 10% errors, the health gate rolls back on its own.
          </li>
          <li>
            <b>Decide.</b> After each stage it's your call: proceed or roll back. The gate only catches big failures,
            so compare with the baseline and ask the co-pilot ("why is SYD elevated?"). It can look things up, and it
            can propose actions for you to approve. You can also type <code>deploy</code>, <code>proceed</code>,{" "}
            <code>rollback</code>, <code>status</code> or <code>review</code>.
          </li>
          <li>
            <b>Fail stale</b> (top bar). Datacenters validate new configs and keep serving the last known-good one if
            validation fails.
          </li>
        </ol>
        <p className="muted">
          <b>Scoring.</b> Bad changes must end rolled back; good changes must reach 100%. The grade comes from the
          blast radius, and big-bang deploys cap at B: getting lucky isn't engineering.
        </p>
        <div className="help-actions">
          <button className="btn btn-primary" value="close">
            Start playing
          </button>
        </div>
      </form>
    </dialog>
  );
}
