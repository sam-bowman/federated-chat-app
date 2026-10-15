import { useFederationEnabled } from "../lib/federation";

/**
 * A line under a header, shown only on a private server (FEDERATION_ENABLED=false) and only where what is on the page lives on
 * another server: the conversation or community is still there to read, but nothing reaches the other server until the
 * administrator turns federation back on. `children` says what that means in this place.
 */
export default function PrivateServerNotice({ show, children }: { show: boolean; children: React.ReactNode }) {
  const federating = useFederationEnabled();
  if (federating || !show) return null;
  return (
    <div className="private-server-notice" role="note">
      {children}
    </div>
  );
}
