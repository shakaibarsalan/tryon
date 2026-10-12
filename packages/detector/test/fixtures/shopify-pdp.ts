// Shopify (Dawn-like) product page: JSON-LD @graph, srcset with width params, legacy size suffixes,
// header logo, mega-menu image, payment icon in the footer, and a "You may also like" grid.
export const shopifyPdp = {
  url: "https://shop.example.com/products/sicilia-ruffle-midi-dress",
  html: `<!doctype html>
<html><head>
<title>Sicilia Ruffle Midi Dress – Maison Demo</title>
<meta property="og:type" content="product">
<meta property="og:title" content="Sicilia Ruffle Midi Dress">
<meta property="og:image" content="http://shop.example.com/cdn/shop/files/sicilia-front.jpg?v=1712">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"Organization","name":"Maison Demo","logo":"https://shop.example.com/cdn/shop/files/logo.png"},
  {"@type":"BreadcrumbList","itemListElement":[
    {"@type":"ListItem","position":2,"name":"Dresses","item":"https://shop.example.com/collections/dresses"},
    {"@type":"ListItem","position":1,"name":"Home","item":"https://shop.example.com/"},
    {"@type":"ListItem","position":3,"name":"Sicilia Ruffle Midi Dress"}]},
  {"@type":"WebPage","mainEntity":{"@type":"Product","name":"Sicilia Ruffle Midi Dress","category":"Dresses",
    "image":["https://cdn.shopify.com/s/files/1/0607/2891/files/sicilia-front.jpg?v=1712"],
    "offers":[{"@type":"Offer","price":"189.00","priceCurrency":"USD","sku":"SIC-001"}]}}
]}
</script>
</head>
<body class="template-product">
<header class="site-header">
  <a href="/" class="header__logo"><img src="/cdn/shop/files/logo.png?v=1&width=300" alt="Maison Demo" data-test-w="200" data-test-h="200"></a>
  <nav><ul><li><a href="/collections/new"><img src="/cdn/shop/files/menu-promo.jpg?v=1&width=400" alt="New in" data-test-w="300" data-test-h="400"></a></li></ul></nav>
</header>
<main>
  <section class="product">
    <div class="product__media-gallery">
      <div class="product__media"><img id="hero" src="/cdn/shop/files/sicilia-front.jpg?v=1712&width=533"
        srcset="/cdn/shop/files/sicilia-front.jpg?v=1712&width=165 165w, /cdn/shop/files/sicilia-front.jpg?v=1712&width=360 360w,
                /cdn/shop/files/sicilia-front.jpg?v=1712&width=533 533w, /cdn/shop/files/sicilia-front.jpg?v=1712&width=720 720w"
        alt="Sicilia Ruffle Midi Dress in poppy red" data-test-w="600" data-test-h="900"></div>
      <div class="product__media"><img id="back" src="//cdn.shopify.com/s/files/1/0607/2891/files/sicilia-back_533x.jpg?v=1712"
        alt="Back view" data-test-w="600" data-test-h="900" data-test-x="620" data-test-y="40"></div>
      <div class="product__media"><img id="detail" src="//cdn.shopify.com/s/files/1/0607/2891/files/sicilia-detail_{width}x.jpg?v=1712"
        alt="Fabric detail" data-test-w="300" data-test-h="450"></div>
    </div>
    <div class="product__info"><h1>Sicilia Ruffle Midi Dress</h1><p class="price">$189.00</p></div>
  </section>
  <section class="related-products">
    <h2>You may also like</h2>
    <ul class="grid">
      <li class="grid__item"><a href="/products/linen-camp-shirt"><img id="rel-shirt" src="/cdn/shop/files/linen-shirt.jpg?v=2&width=360" alt="" data-test-w="240" data-test-h="320"><span class="card__title">Linen Camp Shirt</span></a></li>
      <li class="grid__item"><a href="/products/wide-leg-trousers"><img id="rel-trousers" src="/cdn/shop/files/trousers.jpg?v=2&width=360" alt="" data-test-w="240" data-test-h="320"><span class="card__title">Wide Leg Trousers</span></a></li>
      <li class="grid__item"><a href="/products/ankle-boots"><img id="rel-boots" src="/cdn/shop/files/boots.jpg?v=2&width=360" alt="" data-test-w="240" data-test-h="320"><span class="card__title">Leather Ankle Boots</span></a></li>
    </ul>
  </section>
</main>
<footer><img src="/cdn/shop/files/payment-visa.png" alt="Visa" data-test-w="150" data-test-h="150"></footer>
</body></html>`,
};
