import { useEffect, useState } from "react";

// Shows the total of a cart in the currency of the shop.
export function CartTotal({ cartId, currency }) {
  const [total, setTotal] = useState(null);

  useEffect(() => {
    fetch(`/api/carts/${cartId}/total?currency=${currency}`)
      .then((response) => response.json())
      .then((data) => setTotal(data.total));
  }, [cartId]);

  return <strong>{total === null ? "..." : total}</strong>;
}
