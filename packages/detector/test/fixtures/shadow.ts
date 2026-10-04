// Product page whose gallery lives in open shadow roots (custom elements), attached by the test.
export const shadowPdp = {
  url: "https://www.example-guess.com/en-us/satin-wrap-blouse/W4YH12.html",
  html: `<!doctype html>
<html><head>
<title>Satin Wrap Blouse</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Satin Wrap Blouse","sku":"W4YH12",
 "image":["https://img.example-guess.com/is/image/Guess/W4YH12-A10B-ALT1?wid=1500"],
 "offers":{"@type":"Offer","price":"98","priceCurrency":"USD"}}
</script>
</head>
<body>
<header class="site"><promo-strip id="promo-host"></promo-strip></header>
<main>
  <div class="pdp">
    <product-gallery id="gallery-host"></product-gallery>
    <h1>Satin Wrap Blouse</h1>
  </div>
  <img id="light-small" src="https://img.example-guess.com/is/image/Guess/editorial-strip?wid=400" data-test-w="110" data-test-h="110">
  <div id="deep-host"></div>
</main>
</body></html>`,
  /** Light DOM inside <product-gallery>'s shadow root. */
  galleryShadow: `<div class="gallery">
    <img id="s-main" src="https://img.example-guess.com/is/image/Guess/W4YH12-A10B-ALT1?wid=700" alt="" data-test-w="560" data-test-h="840" data-test-x="0" data-test-y="0">
    <img id="s-alt" src="https://img.example-guess.com/is/image/Guess/W4YH12-A10B-ALT2?wid=700" alt="" data-test-w="560" data-test-h="840" data-test-x="580" data-test-y="0">
    <zoom-viewer id="zoom-host"></zoom-viewer>
  </div>`,
  /** Nested shadow root inside <zoom-viewer>. */
  zoomShadow: `<figure class="zoom"><img id="s-zoom" src="https://img.example-guess.com/is/image/Guess/W4YH12-A10B-ALT3?wid=700" alt="" data-test-w="560" data-test-h="840" data-test-x="1160" data-test-y="0"></figure>`,
  /** Shadow content of the header promo (must be rejected: host is inside <header>). */
  promoShadow: `<img id="s-promo" src="https://img.example-guess.com/is/image/Guess/promo-model-77?wid=700" data-test-w="300" data-test-h="400">`,
};
