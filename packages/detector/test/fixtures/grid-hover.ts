// Collection page with hover-flip cards (front + hover image per card) in three common markups.
export const gridHover = {
  url: "https://shop.example.com/collections/women",
  html: `<!doctype html>
<html><head>
<title>Women – Demo</title>
<meta property="og:type" content="website">
<meta property="og:title" content="Women's Shirts">
</head>
<body>
<main>
  <h1>Women's Shirts</h1>
  <div class="collection-grid">
    <!-- 1. Dawn-like: both images visible and stacked, link lives in the card content -->
    <div class="card" id="c1">
      <div class="card__media">
        <img id="c1-front" src="https://img.example.com/p/linen-shirt-front-0101.jpg" alt="" data-test-w="300" data-test-h="400" data-test-x="0" data-test-y="0">
        <img id="c1-back" src="https://img.example.com/p/linen-shirt-back-0101.jpg" alt="" data-test-w="300" data-test-h="400" data-test-x="0" data-test-y="0">
      </div>
      <h3 class="card__title"><a href="/products/linen-camp-shirt">Linen Camp Shirt</a></h3>
      <span class="price">Rs. 4,990</span>
    </div>
    <!-- 2. Link wraps both images; hover image faded out -->
    <div class="card" id="c2">
      <a href="/products/wide-leg-trousers" class="card__link">
        <img id="c2-front" src="https://img.example.com/p/trousers-front-0202.jpg" alt="" data-test-w="300" data-test-h="400" data-test-x="320" data-test-y="0">
        <img id="c2-back" src="https://img.example.com/p/trousers-back-0202.jpg" alt="" style="opacity:0" data-test-w="300" data-test-h="400" data-test-x="320" data-test-y="0">
      </a>
      <h3 class="card__title"><a href="/products/wide-leg-trousers">Wide Leg Trousers</a></h3>
    </div>
    <!-- 3. Hover image hidden until hover; JS swaps .src on hover so data-* holds the stable URL -->
    <div class="card" id="c3">
      <a href="/products/floral-maxi-dress">
        <img id="c3-front" src="https://img.example.com/p/maxi-hover-0303.jpg" data-src="https://img.example.com/p/maxi-front-0303.jpg" alt="Floral Maxi Dress" data-test-w="300" data-test-h="400" data-test-x="640" data-test-y="0">
        <img id="c3-back" src="https://img.example.com/p/maxi-back-0303.jpg" alt="" style="display:none" data-test-w="300" data-test-h="400">
      </a>
      <a href="/products/floral-maxi-dress" class="card__name">Floral Maxi Dress</a>
    </div>
    <!-- 4. Single image card -->
    <div class="card" id="c4">
      <a href="/products/pleated-midi-skirt"><img id="c4-front" src="https://img.example.com/p/skirt-0404.jpg" alt="" data-test-w="300" data-test-h="400" data-test-x="960" data-test-y="0"></a>
      <a href="/products/pleated-midi-skirt"><span class="product-name">Pleated Midi Skirt</span></a>
    </div>
  </div>
</main>
</body></html>`,
};
