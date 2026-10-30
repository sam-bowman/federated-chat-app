import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useOpenReports, waitingLabel } from "../lib/useOpenReports";

/** Settings -> Server administration: the way in to the admin page, shown only to an admin (the server says so in the person's own record). */
export default function AdminLinkSection() {
  const { user } = useAuth();
  // Reports waiting for the admins. An admin without two-factor sign-in is refused the count, and so sees none.
  const waiting = useOpenReports(null, !!user?.isAdmin);
  if (!user?.isAdmin) return null;
  return (
    <>
      <h3>Server administration</h3>
      <p className="hint">You are an admin of this server. The admin page shows what was done on it and, with two-factor sign-in on, lets you manage it.</p>
      <p>
        <Link to="/admin">Open the admin page</Link>
        {waiting.count ? ` · ${waitingLabel(waiting.count)} waiting` : ""}
      </p>
    </>
  );
}
