import { useEffect, useState } from "react";

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
