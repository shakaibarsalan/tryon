# Quality eval

Decides which provider and mode we ship, and whether the desi-wear wedge is real.

## Golden set (to collect)

- **40 person photos** with written consent or a licence that allows this use. Spread across skin tones, body types, genders, hijab/dupatta, full-body and waist-up, indoor light.
- **30 garments**: flat-lay and on-model; tops, bottoms, one-pieces; at least 10 South Asian (kurta, kameez, 2-3 piece suits, dupatta); patterns, sequins, dark colours.
- Files go in `eval/images/` (git-ignored: these are people's photos, never commit them). Copy `manifest.example.json` to `manifest.json` and list them.

## Run

```bash
npm run dev -w api                       # or point --api at a deployed dev Worker
node eval/run.mjs eval/manifest.json --limit 20 --concurrency 2
```

Results land in `eval/out/<run>/` with `results.json` and a blind `rating.html` (shuffled, provider hidden).

## Score

Three raters score each result 1-5 on: garment fidelity, identity kept, body shape kept, artefacts (5 = none), would share. Download the CSV from the sheet.

**Pass bar:** 70% of renders score 4+ on every criterion, overall and on the desi subset. Also report **cost per accepted render** = provider cost ÷ share of renders scoring 4+.

## Compare

Same set, one run per provider/mode: FASHN `performance`, FASHN `balanced`/`quality`, FASHN VTON 1.5 (open, via the dev `hf-space` provider), and a generalist editor if we add one.
