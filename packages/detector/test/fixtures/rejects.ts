// A page full of things that are not garments, plus three images that must survive.
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export const rejects = {
  url: "https://store.example.com/lookbook",
  html: `<!doctype html>
<html><head><title>Lookbook</title></head>
<body>
<header class="masthead">
  <img id="logo" class="site-logo" src="/img/brand.png" alt="Brand" data-test-w="240" data-test-h="120">
</header>
<nav class="mega"><img id="nav-img" src="/img/menu-dress-77.jpg" alt="Dresses" data-test-w="300" data-test-h="400"></nav>
<div role="banner"><img id="role-banner" src="/img/role-banner-11.jpg" data-test-w="300" data-test-h="300"></div>
<main>
  <div class="hero"><img id="banner" src="/img/sale-banner-2026.jpg" alt="Sale" data-test-w="840" data-test-h="300"></div>
  <div class="full-bleed"><img id="full" src="/img/campaign-wide-01.jpg" alt="Campaign" data-test-w="1000" data-test-h="900"></div>
  <img id="strip" src="/img/vertical-strip-01.jpg" data-test-w="150" data-test-h="600">
  <img id="tiny" src="/img/thumb-dress-01.jpg" data-test-w="100" data-test-h="100">
  <div class="review"><img id="avatar" class="reviewer-avatar" src="/img/u/123456.jpg" data-test-w="150" data-test-h="150"></div>
  <img id="payment" src="/assets/payment/visa-card-2026.png" alt="Visa" data-test-w="200" data-test-h="130">
  <img id="flag" src="/img/flags/pk-2026.png" alt="Pakistan flag" data-test-w="160" data-test-h="120">
  <img id="svg" src="/img/illustration-01.svg" data-test-w="300" data-test-h="300">
  <img id="sprite" src="/img/ui-sprite-v2.png" data-test-w="300" data-test-h="300">
  <div style="display:none"><img id="hidden" src="/img/hidden-dress-001.jpg" data-test-w="400" data-test-h="600"></div>
  <img id="invisible" style="visibility:hidden" src="/img/invisible-dress-001.jpg" data-test-w="400" data-test-h="600">
  <div hidden><img id="hidden-attr" src="/img/hidden-attr-001.jpg" data-test-w="400" data-test-h="600"></div>
  <img id="placeholder-only" src="${GIF}" data-test-w="400" data-test-h="600">
  <img id="placeholder-file" src="/img/placeholder.png" data-test-w="400" data-test-h="600">
  <noscript><img id="noscript" src="/img/noscript-dress-001.jpg" data-test-w="400" data-test-h="600"></noscript>

  <article class="post"><header><img id="keep-editorial" src="/img/editorial-kurta-2024.jpg" alt="Editorial" data-test-w="400" data-test-h="600"></header></article>
  <img id="keep-logo-hoodie" src="/img/logo-hoodie-black-01.jpg" alt="Logo Hoodie" data-test-w="400" data-test-h="500">
  <div class="product-gallery"><img id="keep-main" src="/img/dress-main-5521.jpg" alt="Silk slip dress" data-test-w="500" data-test-h="750"></div>
</main>
<footer><img id="footer-img" src="/img/footer-model-01.jpg" data-test-w="300" data-test-h="400"></footer>
<div role="contentinfo"><img id="contentinfo" src="/img/app-store-01.jpg" data-test-w="200" data-test-h="200"></div>
</body></html>`,
};
