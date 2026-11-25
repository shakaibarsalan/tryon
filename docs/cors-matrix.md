# CORS matrix: garment image bytes without extra permissions

Run: 2026-11-25 21:06 (local time), Node v26.13.1, 17 stores from `tools/stores.json`. Regenerate with `node tools/cors-matrix.mjs`.

Question: can the extension's service worker fetch the product image with a plain `fetch()` (no host permission), or does it need `activeTab`, an optional per-store host permission, or the screenshot fallback?

Method, per store (sequential, one request each, 15 s timeout, no retries, no cookies):

1. GET the product page with a desktop Chrome User-Agent.
2. Garment image = JSON-LD `Product`/`ProductGroup` image, else `og:image` (else `twitter:image`).
3. GET the image with `Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop` and `Sec-Fetch-Mode: cors`; read `Access-Control-Allow-Origin` (ACAO).

## Summary

| Verdict | Stores | Pakistani stores |
|---|---|---|
| fetch OK | 3 | 1 |
| needs host permission | 1 | 0 |
| blocked | 12 | 5 |
| no image found | 1 | 1 |
| **Total** | **17** | **7** |

- **fetch OK:** Khaadi, ASOS, AllSaints.
- **Needs host permission:** Uniqlo.
- **Could not test from a script:** Gul Ahmed, J. (Junaid Jamshed), Outfitters, Limelight, Alkaram, Sapphire, Revolve, Zara, H&M, Mango, Nordstrom, Gymshark, Pangaia (Shopify DTC).

What this means for the extension:

- Shopify stores: 0 of 1 fetch OK. The CDN sends `Access-Control-Allow-Origin: *` on both `cdn.shopify.com` and the store's own `/cdn/shop/` path, so step 1 (plain fetch) is enough there.
- Of the 5 stores where the image itself could be requested, 3 allow a plain fetch.
- Image hosts without CORS: `image.uniqlo.com`. Use screenshot-and-crop, or offer the optional host permission for that origin.
- Bot walls answer scripts with 403/429 or a JS challenge, so these rows say nothing about CORS. In a real tab the detector still reads the image URL from the DOM. Check these stores by hand in Chrome.

## Results

| Store | Country | Platform | Page | Image from | Image host (CDN) | Same origin | Image status | Type | Size | ACAO | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Gul Ahmed | PK | ? | blocked (429) |  |  |  |  |  |  |  | **blocked** |
| J. (Junaid Jamshed) | PK | ? | blocked (429) |  |  |  |  |  |  |  | **blocked** |
| Outfitters | PK | ? | blocked (429) |  |  |  |  |  |  |  | **blocked** |
| Limelight | PK | ? | blocked (429) |  |  |  |  |  |  |  | **blocked** |
| Alkaram | PK | ? | blocked (429) |  |  |  |  |  |  |  | **blocked** |
| Sapphire | PK | Salesforce CC | ok (200) |  |  |  |  |  |  |  | **no image found** |
| Khaadi | PK | Salesforce CC | ok (200) | json-ld | pk.khaadi.com (Cloudflare) | yes | 200 | image/jpeg | 475 KB | none | **fetch OK** |
| Revolve | US | ? | blocked (403, Access Denied) |  |  |  |  |  |  |  | **blocked** |
| ASOS | GB | Custom | ok (200) | json-ld | images.asos-media.com (cloudinary) | no | 200 | image/avif | 7 KB | `*` | **fetch OK** |
| Zara | ES | ? | challenge (Akamai bm-verify) |  |  |  |  |  |  |  | **blocked** |
| H&M | SE | ? | blocked (403, Access Denied) |  |  |  |  |  |  |  | **blocked** |
| Uniqlo | JP | Custom | ok (200) | og:image | image.uniqlo.com (Akamai) | no | 200 | image/avif | 91 KB | none | **needs host permission** |
| Mango | ES | ? | blocked (429) |  |  |  |  |  |  |  | **blocked** |
| Nordstrom | US | ? | error: UND_ERR_CONNECT_TIMEOUT |  |  |  |  |  |  |  | **blocked** |
| AllSaints | GB | Salesforce CC | ok (200) | json-ld | media.i.allsaints.com (cloudinary) | no | 200 | image/avif | 29 KB | `*` | **fetch OK** |
| Gymshark | GB | Shopify | ok (200) | json-ld | cdn.shopify.com | no | UND_ERR_CONNECT_TIMEOUT |  |  | none | **blocked** |
| Pangaia (Shopify DTC) | GB | ? | blocked (429) |  |  |  |  |  |  |  | **blocked** |

## Notes per store

- **Gul Ahmed** (https://www.gulahmedshop.com/products/dyed-jacquard-shirt-gls-23-50): page body 2 KB, title "Too many requests", 0 JSON-LD block(s).
- **J. (Junaid Jamshed)** (https://www.junaidjamshed.com/products/black-oversized-asymmetrical-shirt-wtop-25-0004-c): page body 2 KB, title "Too many requests", 0 JSON-LD block(s).
- **Outfitters** (https://outfitters.com.pk/products/f1136-203): page body 2 KB, title "Too many requests", 0 JSON-LD block(s).
- **Limelight** (https://www.limelight.pk/products/a7153st-xsl-489): page body 2 KB, title "Too many requests", 0 JSON-LD block(s).
- **Alkaram** (https://www.alkaramstudio.com/products/stitched-printed-cambric-kurta-gfku7378-dark-blue): page body 2 KB, title "Too many requests", 0 JSON-LD block(s).
- **Sapphire** (https://pk.sapphireonline.pk/collections/modest-wear/products/MODTOP26V302_999.html): page body 357 KB, title "Modest Wear Top MODTOP26V302 Sapphire PK", 3 JSON-LD block(s).
- **Khaadi** (https://pk.khaadi.com/geometric-v-neck-shirt/6-26-406-A-E1-VG_MULTI.html): image: https://pk.khaadi.com/on/demandware.static/-/Sites-khaadi-master-catalog/default/dwbb368fe2/images/hi-res/6-26-406-a-e1_multi_1.jpg; page mentions "captcha" but loaded normally; no ACAO, but the image is same-origin with the page, so activeTab covers it.
- **Revolve** (https://www.revolve.com/runaway-the-label-dawn-scoop-neck-mini-dress-in-black/dp/RUNR-WD414/): page body 489 B, title "Access Denied", 0 JSON-LD block(s).
- **ASOS** (https://www.asos.com/asos-design/asos-design-pleated-cami-midi-dress-with-drawstring-waist-in-navy/prd/204252646): image: https://images.asos-media.com/products/asos-design-pleated-cami-midi-dress-with-drawstring-waist-in-navy/204252646-1-navy; small file: the listed URL is a thumbnail, so the extension should prefer the larger DOM srcset/zoom URL.
- **Zara** (https://www.zara.com/us/en/satin-midi-halter-dress-p04772386.html): page body 2 KB, title "", 0 JSON-LD block(s).
- **H&M** (https://www2.hm.com/en_us/productpage.1281955001.html): page body 412 B, title "Access Denied", 0 JSON-LD block(s).
- **Uniqlo** (https://www.uniqlo.com/us/en/products/E475649-000/00): image: https://image.uniqlo.com/UQ/ST3/us/imagesgoods/475649/item/usgoods_10_475649_3x4.jpg.
- **Mango** (https://shop.mango.com/us/en/p/women/dresses-and-jumpsuits/dresses/short-shirt-dress_17081159): page body 25 KB, title "Vercel Security Checkpoint", 0 JSON-LD block(s).
- **Nordstrom** (https://www.nordstrom.com/s/sorrel-floral-midi-dress/8859306): page request failed (UND_ERR_CONNECT_TIMEOUT) after 10510 ms.
- **AllSaints** (https://www.allsaints.com/us/womenswear/spark-2-in-1-maxi-dress/USW082DB-9363.html): image: https://media.i.allsaints.com/image/list/fn_select:jq:first%28.%5B%5D%7Cif%20has%28%22metadata%22%29%20then%20select%28any%28.metadata%5B%5D%3B%20.external_id%20%3D%3D%20%22sfcc_pdp_gallery_position_prod%22%20and%20.value%20%3D%3D%201%29%29%20else%20empty%20end%29/f_auto,q_auto,dpr_auto,w_837,h_1046,c_fit/USW082DB-9363.json?_i=AG; page mentions "captcha" but loaded normally.
- **Gymshark** (https://www.gymshark.com/products/gymshark-fit-leggings-black-white): image: https://cdn.shopify.com/s/files/1/0156/6146/products/FITLEGGINGSBLACK_WHITE16644.A-Edit_AS.jpg?v=1603373716; image request failed (UND_ERR_CONNECT_TIMEOUT).
- **Pangaia (Shopify DTC)** (https://pangaia.com/products/womens-wool-jersey-trousers-black): page body 2 KB, title "Too many requests", 0 JSON-LD block(s).

## How to read the verdicts

- **fetch OK**: a plain `fetch()` from the service worker works. Either the CDN answers `Access-Control-Allow-Origin: *` (or echoes the extension origin), or the image is on the page's own origin, which `activeTab` covers after the user clicks the toolbar button or the context menu.
- **needs host permission**: the image loads, but without ACAO and from another origin. Use the screenshot-and-crop fallback (`captureVisibleTab`, no prompt), or ask for that CDN origin with `permissions.request` from a click in the side panel ("Sharper image").
- **blocked**: the page or the image refused our script (bot protection, 4xx, timeout). This is a limit of server-side testing: in a real tab the page loads, and the extension can still read the image from the DOM and use the screenshot fallback. Re-check these stores by hand in Chrome.
- **no image found**: the page loaded but carried neither JSON-LD Product images nor `og:image` (often a client-rendered page); the in-page detector reads the DOM instead.
