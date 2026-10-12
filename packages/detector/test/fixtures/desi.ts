// Pakistani store product pages (shapes seen on Shopify and Salesforce Commerce brands) and a shoes page.

export const desiKurta = {
  url: "https://pk.example-khaadi.com/embroidered-lawn-kurta/ELK24-118.html",
  html: `<!doctype html>
<html><head>
<title>Embroidered Lawn Kurta | Example</title>
<meta property="og:title" content="Embroidered Lawn Kurta">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[
  {"@type":"ListItem","position":1,"item":{"@id":"https://pk.example-khaadi.com/","name":"Home"}},
  {"@type":"ListItem","position":2,"item":{"@id":"https://pk.example-khaadi.com/women/","name":"Women"}},
  {"@type":"ListItem","position":3,"item":{"@id":"https://pk.example-khaadi.com/women/kurta/","name":"Kurta"}}]}
</script>
<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"Product","name":"Embroidered Lawn Kurta","category":"Ready to Wear",
 "sku":"ELK24-118","brand":{"@type":"Brand","name":"Example"},
 "image":"https://pk.example-khaadi.com/dw/image/v2/BJTG_PRD/on/demandware.static/-/Sites-master/default/dw9a1/images/hi-res/ELK24-118_1.jpg?sw=1200",
 "offers":{"@type":"Offer","priceCurrency":"PKR","price":"6990","availability":"https://schema.org/InStock"}}
</script>
</head>
<body>
<main>
  <nav aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li><a href="/women/">Women</a></li><li>Kurta</li></ol></nav>
  <div class="pdp-main">
    <div class="product-images">
      <img id="main" src="/dw/image/v2/BJTG_PRD/on/demandware.static/-/Sites-master/default/dw9a1/images/hi-res/ELK24-118_1.jpg?sw=600"
           data-zoom-image="/dw/image/v2/BJTG_PRD/on/demandware.static/-/Sites-master/default/dw9a1/images/hi-res/ELK24-118_1.jpg?sw=2000"
           alt="Embroidered Lawn Kurta" data-test-w="520" data-test-h="780">
      <img id="second" src="/dw/image/v2/BJTG_PRD/on/demandware.static/-/Sites-master/default/dw9a1/images/hi-res/ELK24-118_2.jpg?sw=600"
           alt="Embroidered Lawn Kurta" data-test-w="520" data-test-h="780" data-test-x="540" data-test-y="0">
      <img id="third" src="/dw/image/v2/BJTG_PRD/on/demandware.static/-/Sites-master/default/dw9a1/images/hi-res/ELK24-118_3.jpg?sw=600"
           alt="Embroidered Lawn Kurta" data-test-w="520" data-test-h="780" data-test-x="1080" data-test-y="0">
    </div>
    <div class="product-detail"><h1>Embroidered Lawn Kurta</h1><span class="price">PKR 6,990</span></div>
  </div>
</main>
</body></html>`,
};

export const desiSuit = {
  url: "https://www.example-gulahmed.com/products/printed-lawn-3-piece-unstitched-suit-cl-22071",
  html: `<!doctype html>
<html><head>
<title>Printed Lawn 3 Piece Unstitched Suit CL-22071</title>
<meta property="og:type" content="product">
<meta property="og:title" content="Printed Lawn 3 Piece Unstitched Suit CL-22071">
<meta property="og:image" content="https://www.example-gulahmed.com/cdn/shop/files/CL-22071_1.jpg?v=171">
<script type="application/ld+json">
[{"@context":"http://schema.org","@type":"BreadcrumbList","itemListElement":[
   {"@type":"ListItem","position":1,"name":"Home","item":"https://www.example-gulahmed.com/"},
   {"@type":"ListItem","position":2,"name":"Unstitched","item":"https://www.example-gulahmed.com/collections/unstitched"},
   {"@type":"ListItem","position":3,"name":"Lawn","item":"https://www.example-gulahmed.com/collections/lawn"}]},
 {"@context":"http://schema.org/","@type":"ProductGroup","name":"Printed Lawn 3 Piece Unstitched Suit CL-22071","productGroupID":"8812",
  "hasVariant":[{"@type":"Product","name":"Printed Lawn 3 Piece Unstitched Suit CL-22071 - Default","sku":"CL-22071",
    "image":"https://www.example-gulahmed.com/cdn/shop/files/CL-22071_1.jpg?v=171&width=1920",
    "offers":{"@type":"Offer","price":"5490.00","priceCurrency":"PKR"}}]}]
</script>
</head>
<body>
<main>
  <div class="product__media-list">
    <img id="suit" srcset="//www.example-gulahmed.com/cdn/shop/files/CL-22071_1.jpg?v=171&width=360 360w, //www.example-gulahmed.com/cdn/shop/files/CL-22071_1.jpg?v=171&width=720 720w"
         src="//www.example-gulahmed.com/cdn/shop/files/CL-22071_1.jpg?v=171&width=720" alt="" data-test-w="560" data-test-h="840">
  </div>
  <h1>Printed Lawn 3 Piece Unstitched Suit CL-22071</h1>
</main>
</body></html>`,
};

export const shoesPdp = {
  url: "https://shop.example.com/products/leather-ankle-boots",
  html: `<!doctype html>
<html><head>
<title>Leather Ankle Boots</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Leather Ankle Boots","category":"Shoes",
 "image":"https://shop.example.com/cdn/shop/files/ankle-boots-tan.jpg?v=3",
 "offers":{"@type":"Offer","price":"220","priceCurrency":"USD","sku":"BOOT-7"}}
</script>
</head>
<body><main><div class="product-gallery">
  <img id="boot" src="/cdn/shop/files/ankle-boots-tan.jpg?v=3&width=800" alt="Tan boots" data-test-w="600" data-test-h="600">
</div><h1>Leather Ankle Boots</h1></main></body></html>`,
};
