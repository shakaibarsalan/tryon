# CORS matrix: garment image bytes without extra permissions

Run: 2026-10-04 17:20 (local time), Node v24.19.0, 15 stores from `tools/stores.json`. Regenerate with `node tools/cors-matrix.mjs`.

Question: can the extension's service worker fetch the product image with a plain `fetch()` (no host permission), or does it need `activeTab`, an optional per-store host permission, or the screenshot fallback?

Method, per store (sequential, one request each, 15 s timeout, no retries, no cookies):

1. GET the product page with a desktop Chrome User-Agent.
2. Garment image = JSON-LD `Product`/`ProductGroup` image, else `og:image` (else `twitter:image`).
3. GET the image with `Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop` and `Sec-Fetch-Mode: cors`; read `Access-Control-Allow-Origin` (ACAO).

## Summary

| Verdict | Stores | Pakistani stores |
|---|---|---|
| fetch OK | 8 | 5 |
| needs host permission | 1 | 0 |
| blocked | 6 | 0 |
| no image found | 0 | 0 |
| **Total** | **15** | **5** |

- **fetch OK:** Gul Ahmed, J. (Junaid Jamshed), Outfitters, Limelight, Alkaram, ASOS, Gymshark, Pangaia (Shopify DTC).
- **Needs host permission:** Uniqlo.
- **Could not test from a script:** Revolve, Zara, H&M, Mango, Nordstrom, AllSaints.

What this means for the extension:

- Shopify stores: 7 of 7 fetch OK. The CDN sends `Access-Control-Allow-Origin: *` on both `cdn.shopify.com` and the store's own `/cdn/shop/` path, so step 1 (plain fetch) is enough there.
- Of the 9 stores where the image itself could be requested, 8 allow a plain fetch.
- Image hosts without CORS: `image.uniqlo.com`. Use screenshot-and-crop, or offer the optional host permission for that origin.
- Bot walls answer scripts with 403/429 or a JS challenge, so these rows say nothing about CORS. In a real tab the detector still reads the image URL from the DOM. Check these stores by hand in Chrome.

## Results

| Store | Country | Platform | Page | Image from | Image host (CDN) | Same origin | Image status | Type | Size | ACAO | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Gul Ahmed | PK | Shopify | ok (200) | json-ld | www.gulahmedshop.com (Cloudflare) | yes | 200 | image/webp | 95 KB | `*` | **fetch OK** |
| J. (Junaid Jamshed) | PK | Shopify | ok (200) | json-ld | cdn.shopify.com (Shopify CDN) | no | 200 | image/webp | 32 KB | `*` | **fetch OK** |
| Outfitters | PK | Shopify | ok (200) | json-ld | outfitters.com.pk (Cloudflare) | yes | 200 | image/webp | 186 KB | `*` | **fetch OK** |
| Limelight | PK | Shopify | ok (200) | json-ld | www.limelight.pk (Cloudflare) | yes | 200 | image/webp | 323 KB | `*` | **fetch OK** |
| Alkaram | PK | Shopify | ok (200) | json-ld | www.alkaramstudio.com (Cloudflare) | yes | 200 | image/webp | 57 KB | `*` | **fetch OK** |
| Revolve | US | ? | blocked (403, Access Denied) |  |  |  |  |  |  |  | **blocked** |
| ASOS | GB | Custom | ok (200) | json-ld | images.asos-media.com (cloudinary) | no | 200 | image/avif | 7 KB | `*` | **fetch OK** |
| Zara | ES | ? | challenge (Akamai bm-verify) |  |  |  |  |  |  |  | **blocked** |
| H&M | SE | ? | blocked (403, Access Denied) |  |  |  |  |  |  |  | **blocked** |
| Uniqlo | JP | Custom | ok (200) | og:image | image.uniqlo.com (Akamai) | no | 200 | image/avif | 91 KB | none | **needs host permission** |
| Mango | ES | ? | blocked (429) |  |  |  |  |  |  |  | **blocked** |
| Nordstrom | US | ? | challenge (F5/Shape bot defense) |  |  |  |  |  |  |  | **blocked** |
| AllSaints | GB | ? | blocked (403) |  |  |  |  |  |  |  | **blocked** |
| Gymshark | GB | Shopify | ok (200) | json-ld | cdn.shopify.com (Shopify CDN) | no | 200 | image/webp | 79 KB | `*` | **fetch OK** |
| Pangaia (Shopify DTC) | GB | Shopify | ok (200) | json-ld | pangaia.com (Cloudflare) | yes | 200 | image/webp | 85 KB | `*` | **fetch OK** |

## Notes per store

- **Gul Ahmed** (https://www.gulahmedshop.com/products/dyed-jacquard-shirt-gls-23-50): image: https://www.gulahmedshop.com/cdn/shop/files/gls-23-50_5_1024x1024.jpg?v=1758377940; page mentions "captcha" but loaded normally.
- **J. (Junaid Jamshed)** (https://www.junaidjamshed.com/products/black-oversized-asymmetrical-shirt-wtop-25-0004-c): image: https://cdn.shopify.com/s/files/1/0702/2487/1584/files/0004c-1_1_f63b1c7e-835c-42b2-9b6c-9b28e75e3605.jpg?v=1776976854; page mentions "captcha" but loaded normally.
- **Outfitters** (https://outfitters.com.pk/products/f1136-203): image: https://outfitters.com.pk/cdn/shop/files/F1136203001_1.jpg?v=1786601825&width=1920; page mentions "captcha" but loaded normally.
- **Limelight** (https://www.limelight.pk/products/a7153st-xsl-489): image: https://www.limelight.pk/cdn/shop/files/A7153ST-SML-489-2PieceSilkSuit_Pret_2.jpg?v=1790761629&width=1920; page mentions "captcha" but loaded normally.
- **Alkaram** (https://www.alkaramstudio.com/products/stitched-printed-cambric-kurta-gfku7378-dark-blue): image: https://www.alkaramstudio.com/cdn/shop/files/CAP2P25-5-432_i_1_04bbf8e6-f76b-4465-a1dd-1c73a2ff4771.jpg?v=1750756215&width=1920; page mentions "captcha" but loaded normally.
- **Revolve** (https://www.revolve.com/runaway-the-label-dawn-scoop-neck-mini-dress-in-black/dp/RUNR-WD414/): page body 489 B, title "Access Denied", 0 JSON-LD block(s).
- **ASOS** (https://www.asos.com/asos-design/asos-design-pleated-cami-midi-dress-with-drawstring-waist-in-navy/prd/204252646): image: https://images.asos-media.com/products/asos-design-pleated-cami-midi-dress-with-drawstring-waist-in-navy/204252646-1-navy; small file: the listed URL is a thumbnail, so the extension should prefer the larger DOM srcset/zoom URL.
- **Zara** (https://www.zara.com/us/en/satin-midi-halter-dress-p04772386.html): page body 2 KB, title "", 0 JSON-LD block(s).
- **H&M** (https://www2.hm.com/en_us/productpage.1281955001.html): page body 414 B, title "Access Denied", 0 JSON-LD block(s).
- **Uniqlo** (https://www.uniqlo.com/us/en/products/E475649-000/00): image: https://image.uniqlo.com/UQ/ST3/us/imagesgoods/475649/item/usgoods_10_475649_3x4.jpg.
- **Mango** (https://shop.mango.com/us/en/p/women/dresses-and-jumpsuits/dresses/short-shirt-dress_17081159): page body 33 KB, title "Vercel Security Checkpoint", 0 JSON-LD block(s).
- **Nordstrom** (https://www.nordstrom.com/s/sorrel-floral-midi-dress/8859306): page body 245 KB, title "", 0 JSON-LD block(s).
- **AllSaints** (https://www.allsaints.com/us/womenswear/spark-2-in-1-maxi-dress/USW082DB-9363.html): page body 897 KB, title "", 0 JSON-LD block(s).
- **Gymshark** (https://www.gymshark.com/products/gymshark-fit-leggings-black-white): image: https://cdn.shopify.com/s/files/1/0156/6146/products/FITLEGGINGSBLACK_WHITE16644.A-Edit_AS.jpg?v=1603373716.
- **Pangaia (Shopify DTC)** (https://pangaia.com/products/womens-wool-jersey-trousers-black): image: https://pangaia.com/cdn/shop/files/10002820_9868_WomensWoolJerseyTrousers_Black.jpg?v=1790079109&width=2400; page mentions "captcha" but loaded normally.

## How to read the verdicts

- **fetch OK**: a plain `fetch()` from the service worker works. Either the CDN answers `Access-Control-Allow-Origin: *` (or echoes the extension origin), or the image is on the page's own origin, which `activeTab` covers after the user clicks the toolbar button or the context menu.
- **needs host permission**: the image loads, but without ACAO and from another origin. Use the screenshot-and-crop fallback (`captureVisibleTab`, no prompt), or ask for that CDN origin with `permissions.request` from a click in the side panel ("Sharper image").
- **blocked**: the page or the image refused our script (bot protection, 4xx, timeout). This is a limit of server-side testing: in a real tab the page loads, and the extension can still read the image from the DOM and use the screenshot fallback. Re-check these stores by hand in Chrome.
- **no image found**: the page loaded but carried neither JSON-LD Product images nor `og:image` (often a client-rendered page); the in-page detector reads the DOM instead.
