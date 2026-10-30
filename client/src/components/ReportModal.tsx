import { useId, useState } from "react";
import * as api from "../api";
import type { ReportKind, ReportReason } from "../api";
import { MAX_DETAILS, REPORT_REASON_OPTIONS, reportFailureMessage, reportTitle } from "../lib/reports";
import { noAutofill } from "../lib/noAutofill";
import Button from "./Button";
import Modal from "./Modal";

interface Props {
  kind: ReportKind;
  /** The message's, person's or community's id. */
  id: string;
  /** What is being reported, as the person knows it: "Kim", "this message", the community's name. Shown as text. */
  name: string;
  /** The server the thing lives on when it is not this one, so a refusal can say where to report it. */
  domain?: string;
  onClose: () => void;
}

/**
 * Report a message, a person or a community (#58). It says plainly who will see the report and that the person reported is not told,
 * asks for a reason and, if the person wants, a few words, and says only that it was sent: nothing here can look the report up again.
 */
export default function ReportModal({ kind, id, name, domain, onClose }: Props) {
  const reasonName = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const goesTo =
    kind === "message"
      ? "A moderator of the community, or the server's admins, will look at it."
      : "The server's admins will look at it.";

  // The people who read it can see it came from you; the person reported is never told.
  const notTold =
    kind === "message" ? "The person who wrote it is not told." : kind === "user" ? "They are not told." : "The community's owner is not told.";

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await api.reportContent({ kind, id, reason, ...(details.trim() ? { details: details.trim() } : {}) });
      setSent(true);
    } catch (err) {
      setError(reportFailureMessage(err, kind, domain));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Modal title="Report sent" onClose={onClose} width={440}>
        <p>Thank you. Your report about {name} was sent.</p>
        <p className="hint">
          {goesTo} They can see it came from you. {notTold}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.875rem" }}>
          <Button onClick={onClose}>Done</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={reportTitle(kind)} onClose={onClose} width={480}>
      <form onSubmit={(e) => void send(e)} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <p className="hint">
          You are reporting {name}. {goesTo} They can see who reported it. {notTold}
        </p>
        <fieldset className="radio-fieldset" disabled={busy}>
          <legend>What is wrong?</legend>
          {REPORT_REASON_OPTIONS.map((option) => (
            <label key={option.value} className="appearance-check">
              <input type="radio" name={reasonName} value={option.value} checked={reason === option.value} onChange={() => setReason(option.value)} />
              <span>
                {option.label}
                <span className="hint" style={{ display: "block" }}>
                  {option.hint}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="hint" htmlFor={`${reasonName}-details`}>
          Anything a moderator should know? (optional)
        </label>
        <textarea
          {...noAutofill}
          id={`${reasonName}-details`}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          maxLength={MAX_DETAILS}
          rows={3}
          disabled={busy}
        />
        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: "0.625rem", justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!reason || busy}>
            Send report
          </Button>
        </div>
      </form>
    </Modal>
  );
}
