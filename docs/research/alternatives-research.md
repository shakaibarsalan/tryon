# Virtual try-on: cost-friendly alternatives to Decart Anywear

Research date: 4 Oct 2026. Every price/claim carries a source tag [n] (list at the end). "EST" = my own arithmetic or assumption, not a vendor figure. Not legal advice.

## 0. Bottom line

1. **Live webcam video (Anywear's mode) is the expensive part.** Decart's Lucy VTON 3.5 costs $0.02/s ($1.20/min) real-time, $0.04/s in fast mode [1][2]. Anywear's own stats say the average try-on session lasts 7.8 minutes with 8.7 items tried [3]. EST: about $9 per shopper session if billed for the whole time. That is why the free beta already has a queue and a 2-try cap for free users [4]. We cannot match "free live video" with our own money.
2. **Still-image try-on is cheap and getting cheaper.** Hosted APIs run $0.03 to $0.10 per image. The first commercially licensed open model, FASHN VTON v1.5 (Apache-2.0, about 8 GB VRAM, about 5 s on an H100), self-hosts at roughly $0.005 to $0.02 per image (EST) [5][6].
3. **Most well-known open VTON models cannot be used commercially.** IDM-VTON, CatVTON, OOTDiffusion, StableVITON and FitDiT are all CC BY-NC-SA 4.0 [7][8][9][10][11]. Licensing is the main trap.
4. **The consumer Chrome extension has a thin moat.** Google ships a native "Try it on" in Chrome and Search, free [12][13]. Anywear and Stylar are free. The monetizable product is the embeddable B2B widget, where competitors charge about $0.10 to $0.17 per try-on [14].
5. **Legal exposure is real but manageable.** BIPA suits against virtual try-on tools are alive (MAC Cosmetics motion to dismiss denied June 2026) [15]. Use ephemeral processing, explicit consent, and `activeTab` instead of `<all_urls>`.

## 1. Hosted image try-on APIs (person photo + garment image -> image)

| Provider / model | Price per image | Latency | Notes and limits |
|---|---|---|---|
| **FASHN API v1.6** | $0.075 on-demand (1 credit). Commit tiers cut the credit price to $0.0675 ($19/mo), $0.06 ($249/mo) and $0.0488 ($1,249/mo) [16] | about 5 s performance, 8 s balanced, 12-17 s quality [17] | Output 864x1296. Result URLs live 3 days. Max 4 samples per call. Try-On Max: 4 credits and about 50 s (Jan 2026 changelog) [18]; help page says 2-5 credits by mode and resolution [16]. Best on one-pieces and sequins in a 160-pair benchmark [19] |
| **Google Vertex AI Virtual Try-On** (`virtual-try-on-001`) | $0.06 [20] (secondary sources; I could not load Google's own price table) | not documented | GA Jan 2026. Quota 50 req/min/region, 10 MB inputs, up to 4 outputs, digital watermark and C2PA content credentials. **Model discontinuation date 20 Jan 2027** [21][22] |
| **Gemini 3.1 Flash Image** ("Nano Banana 2") | $0.045 (0.5K), $0.067 (1K), $0.101 (2K), $0.151 (4K). No free tier. Batch -50% [23] | not published | General editor, not a dedicated VTON model. Dev forum reports face distortion and wrong sleeves [24]. Least consistent of 5 models in a benchmark, with one safety-filter block in 160 [19] |
| **Gemini 3.1 Flash Lite Image** | $0.0336 at 1K [23] | not published | Cheapest Google option. Quality for try-on untested by me |
| Gemini 3 Pro Image ("Nano Banana Pro") | $0.134 (1K/2K), $0.24 (4K) [23] | not published | Premium tier |
| Gemini 2.5 Flash Image | $0.039 [23] | n/a | **Deprecated and shut down 2 Oct 2026** [23]. Do not build on it |
| **OpenAI gpt-image-2** | about $0.006 / $0.053 / $0.211 (low/med/high, 1024x1024) [25]. gpt-image-1.5: $0.009 / $0.034 / $0.133 [26] | not published | Secondary sources only. They disagree on 1.5 medium ($0.034 vs about $0.10) [25][26]. Input images billed extra. gpt-image-1 retires 23 Oct 2026. No try-on benchmark found |
| **Kling Kolors Virtual Try-On v1.5** | $0.07 on fal [27] | about 20 s [28] | fal marks the endpoint **deprecated**. Direct Kling API sells prepaid resource packs (from about $140 per 1,000 units) [28]. Strongest identity preservation in one benchmark [19] |
| **Alibaba Aitryon** (Model Studio) | CNY 0.20 (Basic), CNY 0.50 (Plus), CNY 0.30 (Refiner); 400 free images for 90 days [29] | n/a | Pricing page shows China (Beijing) only. I found no international USD price |
| **Qwen-Image-Edit-2511** (+ try-on LoRAs) | fal $0.035/MP; Replicate $0.05; RunPod public endpoint $0.025; muapi $0.04 [30] | n/a | Apache-2.0 model. "Most balanced generalist" in benchmark [19] |
| BFL FLUX Virtual Try-On | $0.0375 for the first input MP, then $0.005/MP [27] | n/a | Per fal's list |
| Leffa on fal | $0.10 [27] | about 6 s on A100 [31] | |
| fal image-apps-v2 try-on | $0.04, up to 4K [27] | n/a | |
| Pixelcut API | 10 credits = $0.10; garment extraction +50 credits; 100 free credits [32] | n/a | Credit packs from $10/mo |
| Segmind | about $0.13 [33] | n/a | |
| Amazon Nova Canvas `VIRTUAL_TRY_ON` | $0.04 (1024 standard), $0.06 (premium) [34] | n/a | Bedrock. Could use AWS credits for prototyping |
| Perfect Corp YouCam | per-call price not public; 40 free units; SaaS widgets $329 / $489 per month [35] | n/a | Enterprise floors about $10k/yr (third-party claim) [35] |
| Photoroom Virtual Try-On | custom enterprise quote [36] | n/a | |

**Quality notes.** A 160-outfit benchmark (12 May 2026) found: CatVTON best on unusual poses; Kling strongest identity; FASHN best on one-pieces and complex fabrics; Qwen the balanced generalist; Nano Banana Pro the least consistent. Its advice: "Pick two", one dedicated VTON model plus one prompt-driven editor for the long tail [19].

## 2. Hosted video and real-time try-on

| Option | Cost | Notes |
|---|---|---|
| **Decart Lucy VTON 3.5 realtime** | $0.02/s at 720p; fast mode $0.04/s; no minimums; free credits for new accounts [1] | JS/Python/Android/Swift SDKs. Client tokens expire after 10 min. Garment images at least 512x512. Same price on fal [2][37]. VTON 2 and 3 retired Sept 2026 [38] |
| Decart batch video | $0.04/s generated | 5 s clip = $0.20 [1] |
| WaveSpeed AI Virtual Outfit Try-On (video) | $0.039/s, so $0.195 per 5 s | [39] |
| FASHN video | 5 s clip = 1-6 credits, 10 s = 2-12 credits | About $0.075-$0.45 on-demand [16] |
| Kling 3.0 generic video | $0.084/s (720p) | Not a try-on endpoint [40] |
| Daydream (Livepeer) hosted StreamDiffusion | search summary says $1.50/hr after 10 free hours | Unverified at primary source. Generic restyle, not garment-aware [41] |
| Open video VTON | CatV2TON: same repo as CatVTON, CC BY-NC-SA, non-commercial [7]. ViViD: Apache-2.0 per FASHN's guide [42] | Offline diffusion, not real-time |

I found **no** open, commercially licensed, real-time, garment-conditioned video model. The only public self-host attempt (MirrorFit) is an open request with no results [43]. Per-garment real-time research needs a network trained per garment [44]. Live try-on is therefore Decart-only today.

## 3. Open-source models to self-host

| Model | License | VRAM | Speed | Commercial? |
|---|---|---|---|---|
| **FASHN VTON v1.5** (Jan 2026) | **Apache-2.0** [5][6] | about 8 GB [5] | about 5 s on H100 [5] | **Yes, with a caveat.** Output is 576x864. Its optional human-parser weights fall under NVIDIA's SegFormer license, which forbids non-commercial-only use [45][46]. Run with the parser off or swap in an Apache-2.0 segmenter. Limits: imperfect body-shape preservation; old garment can show through [5] |
| **Leffa** (CVPR 2025) | MIT on repo and HF [31][47] | not stated | about 6 s on A100 [31] | **Gray area.** Weights trained on VITON-HD and DressCode, which are non-commercial/academic-only datasets [48]. FASHN warns weights stay bound to dataset terms [42]. Get counsel before using |
| **CatVTON** (ICLR 2025) | CC BY-NC-SA 4.0 [7] | under 8 GB at 1024x768 [7] | about 11 s on A100-class [49] | **No** |
| **IDM-VTON** (ECCV 2024) | CC BY-NC-SA 4.0 [8] | A100 80GB used on Replicate; RTX 4090 about 8 s, 16 GB cards struggle (vendor article) [50] | about 17 s [49][51] | **No** (Replicate page says non-commercial) [51] |
| **OOTDiffusion** | CC BY-NC-SA 4.0 [9][10] | not stated | about 46 s [49] | **No**. Weakest in FASHN's test [49] |
| **FitDiT** | CC BY-NC-SA 4.0; "for commercial use, please visit Tencent Cloud" [11] | not stated | not stated | **No** (paid route via Tencent) |
| **StableVITON** | CC BY-NC-SA 4.0 [52] | not stated | n/a | **No** |
| **OmniTry** | Apache-2.0 LoRA on FLUX.1-Fill-dev [53] | at least 28 GB (bf16) [53] | n/a | **No in practice.** The FLUX.1 dev license is non-commercial for derivatives; commercial deployment needs a paid BFL license [54][55] |
| **Any2AnyTryon** (ICCV 2025) | repo states no license; built on FLUX.1-dev [56] | not stated | n/a | Treat as **No** |
| **Qwen-Image-Edit-2509/2511** | Apache-2.0 [57] | about 45 GB FP16, about 22 GB INT8, about 11 GB INT4 [57] | n/a | **Yes**. Generalist editor, not try-on specific |
| **FLUX.2 klein 4B + try-on LoRA** | Apache-2.0 base and LoRA [58][59] | not stated | n/a | **Yes, but experimental.** LoRA trained on only 273 tuples, weak on all-dark outfits [59]. klein 9B and dev are non-commercial for self-hosting [58] |
| Mobile-VTON (Mar 2026) | paper CC BY-NC-SA [60] | 2.84 GB, 415M params | about 80 s on a Snapdragon 8 Gen 5 NPU for 1024x768 | Research only; not interactive [60] |

**Benchmarks.** On VITON-HD paired FID (lower is better): FitDiT 4.73, Leffa 4.54, CatVTON 6.14, IDM-VTON 6.34. Leffa and FitDiT lead on paper, but FitDiT distorts body shape and Leffa loses pattern clarity in complex regions [61]. FASHN's own June 2025 ranking was CatVTON > IDM-VTON > OOTDiffusion [49]. None of the top-quality research models is commercially usable.

## 4. Self-hosting GPU costs

Prices per hour. RunPod from its pricing page [62]; Modal per-second x 3600 (EST conversion) [63]; Lambda on-demand [64]; cheapest-tracked secure on-demand from GPUPerHour on 4 Oct 2026 [65].

| GPU | RunPod pod (community / secure) | Modal | Lambda | Cheapest tracked (30-day avg) |
|---|---|---|---|---|
| L4 24GB | $0.44 / $0.49 | $0.80 | n/a | $0.33 (Vast) |
| A10 24GB | n/a | $1.10 | $1.29 | n/a |
| L40S 48GB | $0.79 / $1.09 | $1.95 | n/a | $0.97 ($0.90) |
| A100 80GB | $1.19-$1.39 / $1.59 | $2.50 | $2.79 (8x SXM) | $1.38 ($1.06) |
| H100 80GB | $1.99-$2.69 / $2.89-$3.49 | $3.95 | $4.29 (1x SXM) | $2.69 ($2.18) |
| RTX 4090 | $0.34 / $0.69 [66] | n/a | n/a | $0.52 ($0.33) |

RunPod's listed serverless rates are $0.69/hr (24 GB tier), $1.75 (48 GB), $2.72 (A100) and $4.79 (H100) [62]. Modal gives $30/month free credit on Starter and bills per second [63].

**Cold starts.** Modal containers start in 1-2 s, but loading model weights dominates. Reported figures: 2-5 s for small models and 15-30 s for 7B+ [67]. Modal GPU memory snapshots (alpha) can cut this by up to about 10x [67]. RunPod's "sub-second" FlashBoot measured about 7 s in a third-party test [68]. For a paid tier, keep one warm worker.

**Cost per image (EST).** Formula: ($/hr / 3600) x seconds / utilization.
- FASHN VTON 1.5 on Modal H100: 5 s x $0.001097 = **$0.0055**.
- Same model on Modal L40S at an assumed 10 s: **$0.0054**.
- RunPod community 4090 at an assumed 10 s and 25% utilization: **about $0.004**.
- Allow 2-3x for cold starts, idle timeouts and retries, so **$0.01-0.02 practical**.
- Replicate's hosted IDM-VTON, for reference, charges $0.023 per run [51].

## 5. On-device and in-browser (near-zero server cost)

- **Feasible now: 2D overlay.** MediaPipe Pose Landmarker and Image Segmenter run in the browser with a WebGPU delegate. Both are Apache-2.0 [69]. Result: a flat garment cutout warped onto live pose landmarks. Cost is about $0, but it looks like a sticker with no drape. Needs garment background removal, which can also run client-side. Good as an instant preview, not a photoreal result.
- **Not feasible: diffusion in the browser.** ONNX Runtime Web/WebGPU can run Stable Diffusion, but slowly [70]. The best on-device VTON research (Mobile-VTON) takes about 80 s on a flagship phone NPU [60].
- **Hybrid.** Do pose and segmentation, resizing, cropping and consent UI on the client. Send one small image pair to the GPU server. This cuts bandwidth and lets us show an instant 2D preview while the server renders.
- **BYOK.** An open-source Chrome extension already lets users bring their own fal API key, "free until my Fal credits run out", with photos stored locally [71]. Zero cost for us, but low adoption (78 users).

## 6. Competitors

**Chrome extensions**

| Extension | Users / rating | Model and monetization |
|---|---|---|
| **Anywear (Decart)** | 10,000+ users, 3.6 stars (39 ratings), v2.13 updated 30 Sep 2026 [72]. An 8 Aug snapshot showed 2,000 users and 5.0 stars [73] | Free beta, no account. Queue and 2-try limit for free users; 18+ age gate, camera and mic, desktop only [4]. B2B one-line embed script, free trial, enterprise contact sales [3] |
| Google Chrome "Try it on" | Built into Chrome | Free. Needs Google sign-in, 18+, supported retailers and regions only. Photo stored in the user's Google account [12] |
| Stylar | about 3,000 users, 4.4 stars | Free; claims 25,000+ retailers; last updated Aug 2024 [74] |
| fAIshion.AI | 854 users, 4.7 stars | Free, no pricing shown [75] |
| Try-It-On / reStylist / TryOnMe | 262 / 459 users | Small, free [76] |

**Retail and Shopify apps** [14][77][78]

| App | Pricing |
|---|---|
| Genlook (900+ stores, median 8.2 s per try-on, photos deleted after 7 days) | Free 10/mo; $14.99 for 100 ($0.17 overage); $29 for 250 ($0.12); $99 for 1,000 ($0.10) |
| AI Frame | $19.99 / 100; $59.99 / 500; $199.99 / 2,000 |
| TryOn AI Fitting Room | Free 5 images; $20 / 100; $100 / 600; $300 / 2,000 |
| virtual.fit | Free 1,500 credits; $299 / 3,000, then $0.06 each |
| FitRoom | 10 free credits; about $16/mo |
| Camweara / Fittingbox (eyewear) | $39 / $59 per month |
| Google Shopping and Walmart (Zeekit) | Free but locked to their own marketplaces |

**How they monetize.** Freemium credit tiers, per-try-on overage ($0.06-$0.17), email capture and conversion-attributed analytics, and enterprise contracts. Consumer extensions are mostly free, funded by the vendor. Anywear itself reports 11.3% of try-on users clicking add-to-cart [3].

## 7. Legal and platform policy

**Biometrics.**
- **BIPA (Illinois):** $1,000 per negligent and $5,000 per reckless violation. The Aug 2024 amendment (SB 2979) allows one recovery per person; the Seventh Circuit applied it retroactively [79][80]. Try-on suits: eyewear cases were dismissed under the health-care exemption, but the **MAC Cosmetics** motion to dismiss was denied in June 2026 and the case continues [15][81]. Apparel has no healthcare exemption. Mitigate with written consent before capture, a published retention and destruction schedule, no storage of face geometry, and ephemeral processing.
- **Texas CUBI / Washington:** notice and consent. Attorney-General enforcement only, up to $25,000 per violation in Texas. Colorado added biometric consent rules [82].
- **GDPR:** Recital 51 says photographs are biometric only when processed by technical means that uniquely identify a person. Try-on is not identification, so Art. 9 likely does not apply, but marketing use of biometrics generally needs explicit consent. Do a DPIA, sign DPAs with GPU and API vendors, cover US transfers, and exclude minors [83].
- **CCPA/CPRA:** biometric information is sensitive PI when used to uniquely identify. Give a notice at collection with the retention period [84]. Google states its try-on "does not collect or store any biometric data" and does not train on photos; copy that posture [12].
- **Retention precedents:** FASHN output URLs 3 days [17]; Genlook 7 days [14]; Decart's policy (updated 20 Aug 2026) says it collects live video and keeps it until deleted [4]. Retaining less is a selling point.

**Chrome Web Store.**
- Handling user data requires a privacy policy, an in-product prominent disclosure (not only the policy) and the Limited Use rules: no ads, no sale, no human reading without consent [85][86].
- Camera and photos count as user data. Request the narrowest permissions [87].
- `<all_urls>` triggers an in-depth review that can take weeks [88]. Prefer `activeTab` (no install warning; triggered by a click, context-menu item or shortcut) [89] plus `contextMenus` and a side panel.
- MV3 forbids remotely hosted code. Models and WASM must ship in the package; fetching data such as images or config is fine [90].

**Retailer images and ToS.**
- Product photos are the retailer's copyright, and ToS often ban automated access. I found no case law on try-on image proxying; sources say there are no hard rules for web images [91].
- The nearest signal is *Amazon v. Perplexity*: on 4 Aug 2026 the Ninth Circuit vacated the injunction, holding a user-directed agent means the user is accessing the site. CFAA and California computer-crime claims fail on that record; contract and ToS theories remain open [92].
- **Safer design:** fetch the garment image in the user's browser on a user gesture and send it to our server transiently. Do not crawl, cache, store or republish retailer images. For the B2B widget the retailer grants rights to its own catalog in our ToS. Keep a DMCA contact.

## 8. Recommended cost-tiered architecture

**Phase 1 (validate, no infra).** Route everything through hosted APIs: FASHN v1.6 ($0.075) or Vertex ($0.06) as primary, a Qwen-Edit or Gemini 3.1 Flash endpoint for hard cases. Treat the extension as a test bed and lead channel. Avoid Gemini 2.5 Flash Image (shut down) and the deprecated fal Kling endpoint. Watch the Vertex 20 Jan 2027 discontinuation.

**Phase 2 (own the cost curve).** Self-host FASHN VTON 1.5 on Modal or RunPod serverless. Break-even is roughly 5-10k try-ons a month (EST: about $0.05 saved per try-on against the maintenance burden). Keep the hosted API as fallback for quality failures and spikes.

| Tier | What users get | Cost to us |
|---|---|---|
| **Free** | Extension (activeTab, context-menu "Try on"). Instant client-side 2D preview. About 3-5 server renders per day from the self-hosted open model, capped per account and device, with result cache. Optional BYOK for power users | $0 for preview; about $0.01 per render. EST: 1,000 users x 5 renders/mo = about $50/mo |
| **Paid consumer** | Higher quota, higher-res or "max quality" routing to hosted VTON, saved looks. Price against Genlook-style $0.10-0.17 per try-on | $0.01-$0.075 per image |
| **B2B widget/API** | Embed script plus Shopify app. Per-try-on plans ($15-$100/mo tiers, $0.10-$0.17 overage as in Genlook). Conversion analytics, 7-day retention, DPA, BIPA-state consent flow, retailer-warranted imagery | $0.01-$0.075 per image, so about 40-90% gross margin (EST) |
| **Live add-on (enterprise only)** | Decart Lucy VTON API in time-boxed sessions (for example 60 s max). Never free | $1.20 per 60 s (or $2.40 in fast mode) |

Differentiators versus free Google/Anywear: embeddable in the merchant's own store, conversion analytics, no live video retention, no webcam needed.

## 9. Estimated cost per try-on

| Approach | Marginal cost per try-on | Quality | Main caveat |
|---|---|---|---|
| A. Client-side 2D overlay (MediaPipe) | about $0.000 | Low ("sticker") | No drape; needs garment cutout |
| B. Self-hosted FASHN VTON 1.5 (Modal/RunPod) | about $0.005 raw, $0.01-0.02 practical (EST) | Good, 576x864 | Engineering effort; parser license; cold starts |
| C. Hosted image API | $0.03 (Qwen/Gemini Lite), $0.06 (Vertex), $0.075 (FASHN), $0.10 (Pixelcut/Leffa) | Good to best (Try-On Max about $0.30) | Vendor lock-in, deprecations |
| D. Live video (Decart Lucy VTON 3.5) | $0.02/s: $0.60 per 30 s, $1.20 per min; about $9.40 per 7.8-min session (EST) | Highest realism | Cannot be free at scale |
| E. Async video clip (5 s) | about $0.20 (Decart batch, WaveSpeed) | Medium | Slow; not interactive |

## 10. Gaps and uncertainties

- Google's official Vertex price table and OpenAI's per-image table could not be loaded. Both prices come from secondary sources, and the OpenAI sources conflict.
- Self-hosted speeds for FASHN VTON 1.5 on L4/L40S/4090 are not published. The 10 s figures above are my assumption.
- Direct Kling VTO price and Alibaba international pricing were not found.
- Daydream's price is from one search summary only.
- FASHN's consumer plan lists $0.10/credit top-ups [94], while the API pricing page says $0.075 [16]. These are separate products.
- Doppl shutdown on 30 Apr 2026 is confirmed by Google Labs and Genlook [95].

## Sources

[1] https://docs.platform.decart.ai/getting-started/pricing (checked 4 Oct 2026)
[2] https://fal.ai/models/decart/lucy2-vton/realtime
[3] https://anywear.decart.ai/one-pager
[4] https://weartryon.com/guides/anywear (updated 2 Oct 2026)
[5] https://huggingface.co/fashn-ai/fashn-vton-1.5
[6] https://fashn.ai/blog/fashn-vton-1-5-open-source-release ; https://www.communeify.com/en/blog/fashn-vton-v1-5-virtual-try-on-ai-consumer-gpu/ (published 29 Jan 2026)
[7] https://github.com/Zheng-Chong/CatVTON
[8] https://github.com/yisol/IDM-VTON
[9] https://raw.githubusercontent.com/levihsu/OOTDiffusion/main/LICENSE
[10] https://huggingface.co/levihsu/OOTDiffusion
[11] https://github.com/BoyuanJiang/FitDiT
[12] https://support.google.com/chrome/answer/18507944 ; https://support.google.com/googleshopping/answer/16253678
[13] https://adrianarivas.tech/2026/04/18/google-virtual-try-on-retail-2026/
[14] https://genlook.app/shopify ; https://www.digismoothie.com/best-shopify-apps/virtual-try-on
[15] https://openclassactions.com/lawsuits/mac-cosmetics-virtual-try-on-bipa-class-action-lawsuit.php (published 6 Jul 2026)
[16] https://help.fashn.ai/plans-and-pricing/api-pricing
[17] https://docs.fashn.ai/api-reference/tryon-v1-6
[18] https://fashn.ai/changelog/api-try-on-max-endpoint-now-available (25 Jan 2026)
[19] https://www.ionio.ai/blog/vton (12 May 2026)
[20] https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing (the $0.06 per image figure came from search-result summaries of Google's Vertex pricing pages; the page itself was too long for me to load, so treat as secondary-confirmed)
[21] https://docs.cloud.google.com/vertex-ai/generative-ai/docs/release-notes
[22] https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/imagen/virtual-try-on-preview-08-04
[23] https://ai.google.dev/gemini-api/docs/pricing
[24] https://discuss.google.dev/t/issues-with-virtual-try-on-stability-face-distortion-and-incorrect-sleeve-rendering-prompt-for-try-on-in-nano-banana/324604
[25] https://costgoat.com/pricing/openai-images (updated 5 Sep 2026)
[26] https://pricepertoken.com/gpt-image-pricing
[27] https://fal.ai/learn/tools/best-virtual-try-on-apis-2026 ; https://fal.ai/models/fal-ai/kling/v1-5/kolors-virtual-try-on ; https://fal.ai/models/fal-ai/leffa/virtual-tryon
[28] https://www.eachlabs.ai/kling/kling-v1-5/kling-v1-5-kolors-virtual-try-on
[29] https://help.aliyun.com/en/model-studio/billing-for-outfitanyone
[30] https://fal.ai/models/fal-ai/qwen-image-edit-2511/lora ; https://docs.runpod.io/public-endpoints/models/qwen-image-edit-2511-lora
[31] https://github.com/franciszzj/Leffa
[32] https://www.pixelcut.ai/docs/developer-guide/getting-started/pricing
[33] https://www.segmind.com/pixelflows/ai-virtual-try-on/api
[34] https://aws.amazon.com/blogs/aws/amazon-nova-canvas-update-virtual-try-on-and-style-options-now-available
[35] https://yce.perfectcorp.com/ai-api/api-pricing ; https://www.perfectcorp.com/business/plan
[36] https://www.photoroom.com/tools/virtual-try-on
[37] https://docs.platform.decart.ai/models/realtime/virtual-try-on
[38] https://docs.platform.decart.ai/changelog
[39] https://wavespeed.ai/models/wavespeed-ai/ai-virtual-outfit-tryon
[40] https://costbench.com/software/ai-media-apis/kling-api/
[41] https://livepeer.org/ecosystem/daydream (price not on page; search summary only)
[42] https://fashn.ai/blog/so-you-want-to-build-a-virtual-try-on-app-a-developers-guide-to-not-getting
[43] https://github.com/ali-m07/mirrorfit/issues/12
[44] https://arxiv.org/abs/2506.12348
[45] https://github.com/fashn-AI/fashn-human-parser
[46] https://raw.githubusercontent.com/NVlabs/SegFormer/master/LICENSE
[47] https://huggingface.co/franciszzj/Leffa
[48] https://github.com/shadow2496/VITON-HD ; https://github.com/aimagelab/dress-code/blob/main/LICENCE
[49] https://fashn.ai/blog/comparing-the-top-4-open-source-virtual-try-on-viton-models (updated Oct 2026; tests June 2025)
[50] https://fitroom.app/blog/open-source-vton-models-vs-managed-apis (vendor article, May-Jun 2026)
[51] https://replicate.com/cuuupid/idm-vton
[52] https://github.com/rlawjdghek/StableVITON
[53] https://github.com/Kunbyte-AI/OmniTry
[54] https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev
[55] https://github.com/black-forest-labs/flux/blob/main/model_licenses/LICENSE-FLUX1-dev
[56] https://github.com/logn-2024/Any2anyTryon
[57] https://www.spheron.network/tools/gpu-recommender/Qwen/Qwen-Image-Edit-2509/
[58] https://invideo.io/blog/flux-ai-image-generator/ (7 Aug 2026)
[59] https://huggingface.co/xocialize/tryon-FLUX.2-klein-4B-lora
[60] https://arxiv.org/html/2603.00947v4
[61] https://arxiv.org/html/2506.00908 (benchmark tables; FitDiT paper https://arxiv.org/html/2411.10499v1)
[62] https://www.runpod.io/pricing
[63] https://modal.com/pricing
[64] https://lambda.ai/pricing
[65] https://gpuperhour.com/ (4 Oct 2026)
[66] https://www.spheron.network/blog/gpu-cloud-pricing-comparison-runpod-vs-vastai-2026/
[67] https://modal.com/blog/mistral-3 ; https://www.buildmvpfast.com/blog/scale-to-zero-serverless-gpu-modal-runpod-ai-hosting-2026
[68] https://sergeyshmakov.github.io/mineru-runpod/blog/2026-05-26-runpod-flashboot-mechanism-investigation/
[69] https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js ; https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/mediapipe-selfie-segmentation-webgpu-background-blur
[70] https://opensource.microsoft.com/blog/2024/02/29/onnx-runtime-web-unleashes-generative-ai-in-the-browser-using-webgpu/
[71] https://chromewebstore.google.com/detail/virtual-try-on/glimeidbokkhofiiloikgdnkdnofpjbd
[72] https://chromewebstore.google.com/detail/anywear-live-virtual-try/hijnklblgecbdlhjiofhlhjpndpifejh (checked 4 Oct 2026)
[73] Search-result snippet of the Chrome Web Store listing (v1.25, 8 Aug 2026: 2,000 users, 5.0 stars); see also https://www.extspot.com/extension/hijnklblgecbdlhjiofhlhjpndpifejh
[74] https://chromewebstore.google.com/detail/stylar-free-virtual-try-o/mlniogmfpplklfllojkdfgfjiiibcmma
[75] https://chromewebstore.google.com/detail/faishionai-virtual-try-on/gpclcbeibdepihaaeddaaijekabieiok
[76] https://chromewebstore.google.com/detail/try-it-on/jbnjhdmpbgmkchfeamnnhjkncgdcoiia
[77] https://apps.shopify.com/aiframe-virtual-tryon ; https://apps.shopify.com/tryon-2 ; https://apps.shopify.com/virtual-fit
[78] FitRoom ($16/mo, 10 free credits) and Zeekit/Google lock-in came from search summaries only: https://aishirt.app/posts/virtual-try-on-buyer-guide-ecommerce-2026 ; https://thenewblack.ai/blog/best-ai-virtual-try-on-tools
[79] https://www.constangy.com/constangy-cyber-advisor/after-16-years-bipa-is-amended-to-limit-potential-damages-for-violations
[80] https://www.americanbar.org/groups/business_law/resources/business-law-today/2026-may/7th-circuit-holds-bipa-damages-remedy-applies-retroactively/
[81] https://ogletree.com/insights-resources/blog-posts/illinois-federal-judge-finds-another-eyewear-virtual-try-on-class-action-is-exempt-under-bipas-healthcare-exemption/
[82] https://www.zwillgen.com/privacy/texas-cubi-law-and-biometric-privacy/ ; https://www.biometricupdate.com/202506/texas-and-colorado-take-diverging-paths-on-biometric-privacy
[83] https://www.activemind.legal/legislation/gdpr/recital-51/
[84] https://www.termsfeed.com/blog/ccpa-biometrics/
[85] https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
[86] https://developer.chrome.com/docs/webstore/program-policies/limited-use
[87] https://developer.chrome.com/docs/webstore/program-policies/permissions
[88] https://extensionbooster.net/blog/chrome-extension-host-permission-in-depth-review-warning-fix-guide/
[89] https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
[90] https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
[91] https://www.plytix.com/blog/3-reasons-care-product-image-copyright/
[92] https://www.pymnts.com/news/artificial-intelligence/2026/ninth-circuit-narrows-cfaa-reach-in-perplexity-agentic-commerce-ruling/
[94] https://fashn.ai/pricing
[95] https://support.google.com/labs/answer/16537062 ; https://genlook.app/blog/google-doppl-shuts-down-migration
