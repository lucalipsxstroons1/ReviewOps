import { useEffect, useState } from "react";

// Shows the open orders of one customer.
export function OrderList({ customerId, onSelect }) {
  const [orders, setOrders] = useState([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/customers/${customerId}/orders`, { signal: controller.signal })
      .then((response) => response.json())
      .then(setOrders)
      .catch(() => setFailed(true));
    return () => controller.abort();
  }, [customerId]);

  if (failed) {
    return <p>The orders could not be loaded.</p>;
  }

  return (
    <ul>
      {orders.map((order) => (
        <li key={order.id}>
          <button type="button" onClick={() => onSelect(order.id)}>
            {order.number}
          </button>
        </li>
      ))}
    </ul>
  );
}

// Shows the number of open orders of one customer.
export function OrderCount({ customerId }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    fetch(`/api/customers/${customerId}/orders/count`)
      .then((response) => response.json())
      .then((data) => setCount(data.count));
  }, []);

  return <span>{count} open orders</span>;
}
