// Listing page used for garmentFromUrl (context-menu srcUrl) matching.
export const urlMatch = {
  url: "https://www.example-sapphire.pk/collections/kurta",
  html: `<!doctype html>
<html><head>
<title>Kurtas – Example</title>
<meta property="og:title" content="Kurtas">
</head>
<body><main><ul class="products">
  <li class="product-tile">
    <a href="/products/embroidered-lawn-kurta-123">
      <img id="kurta" src="https://cdn.example.pk/products/kurta-123.jpg?v=1" alt="" data-test-w="300" data-test-h="450">
    </a>
    <a href="/products/embroidered-lawn-kurta-123" class="tile-title">Embroidered Lawn Kurta</a>
  </li>
  <li class="product-tile">
    <a href="/products/cotton-shalwar-77">
      <img id="shalwar" srcset="//www.example-sapphire.pk/cdn/shop/files/shalwar-77.jpg?v=5&width=300 300w, //www.example-sapphire.pk/cdn/shop/files/shalwar-77.jpg?v=5&width=600 600w"
           src="//www.example-sapphire.pk/cdn/shop/files/shalwar-77.jpg?v=5&width=600" alt="" data-test-w="300" data-test-h="450">
    </a>
    <a href="/products/cotton-shalwar-77" class="tile-title">Cotton Shalwar</a>
  </li>
</ul></main></body></html>`,
};
