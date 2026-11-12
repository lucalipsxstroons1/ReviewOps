// A small label for the status of an order.
export function Badge({ label, tone = "neutral" }) {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}
