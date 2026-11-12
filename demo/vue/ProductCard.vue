<script>
export default {
  name: "ProductCard",
  props: {
    product: { type: Object, required: true },
  },
  methods: {
    applyDiscount() {
      this.product.price = this.product.price * 0.9;
    },
  },
};
</script>

<template>
  <div class="product-card">
    <h3>{{ product.name }}</h3>
    <p>{{ product.price }}</p>
    <button @click="applyDiscount">Apply 10% discount</button>
  </div>
</template>
