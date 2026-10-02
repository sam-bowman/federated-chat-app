export default function PresenceDot({ status }: { status: string }) {
  return <span className={`presence-dot ${status}`} title={status} />;
}
