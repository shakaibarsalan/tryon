# Try-On privacy notice

Last updated: 25 November 2026

Try-On is a personal project by Shakaib Arsalan, a software engineer in Lahore, Pakistan. It has a Chrome extension, a web try-on page and a small script stores can add to their product pages. All three use the same Try-On API. This notice covers all of them. If something here is unclear, ask on [GitHub](https://github.com/shakaibarsalan/tryon/issues).

## The short version

Your photo and your try-on results are saved in your browser, not on our server. Your photo leaves your device only when you press "Try it on", and then only to make that one picture. You don't need an account. We don't use analytics, ads or cookies, and we don't sell or share data.

## What stays in your browser

- The photo of yourself that you take or upload.
- Your try-on results, with small thumbnails of the garments.
- That you agreed to this notice, your settings, and a random install key that counts your free try-ons.
- The garment you picked last. The extension forgets it when you close Chrome.

The extension keeps these in Chrome's extension storage. The web page and the store script keep them in the storage of the Try-On site, so the store you are shopping on can't read them.

## The live mirror

The live mirror shows your camera with the garment drawn on you. It runs entirely on your computer: the body tracking and the drawing happen in your browser, and camera frames aren't recorded, saved or sent anywhere. "Make it real" saves the frame on screen as your photo, and from then on it's treated like any photo you take or upload. The AI result is kept in your browser like any other result, and the live mirror then draws it on you there; it isn't sent anywhere again.

## What we send, and when

When you press "Try it on", your browser sends the Try-On API:

- your photo and the garment image,
- the garment type (top, bottom or one-piece),
- the address of the store's site, such as `https://www.example-store.com`, never the full page address,
- a random reference for that try-on.

The API passes the two images to the render service, waits for the picture, and hands it back to your browser. The API never writes your photo, the garment image or the result to disk.

We use one of two render services:

- **FASHN's hosted API** ([fashn.ai](https://fashn.ai)). FASHN keeps the images for at most 60 minutes and doesn't train its models on them.
- **Our own copy of the open FASHN VTON 1.5 model**, running on a computer we control. It holds the images in memory only. The photo and garment image are dropped as soon as the render ends, and the result 10 minutes later. Before it renders, it finds points like your shoulders, hips and knees to check that the photo shows one person and enough of the body. Those points are used for that render only and are never stored.

The free demo at tryonlab.vercel.app sends nothing: its sample results are built into the page.

## What our server keeps

The API keeps a small ledger so it can count free try-ons and stop abuse. It holds no images, names or email addresses.

- For each install: a random id, when it was created, and how many free try-ons are left.
- For each try-on: its id, status, garment type, the store's site address, which render service ran it, the cost, how long it took, any error code, and your "Keep" or "Not right" answer if you gave one.
- A daily count of try-ons per network, so one network can't use up the free budget. The IP address is turned into a keyed hash that changes every day, and the IP itself is never stored.

## If you sign in

Signing in is optional. It gives you a few more free try-ons each month once the first ones are used. Sign-in is with Google: Google sends us a signed token that says which Google account you used. We check the token, keep a keyed hash of the account's id, and drop everything else in it, including your name, email and photo. We also count how many try-ons the account used each month.

## How long we keep it

- Try-on rows: 90 days.
- Daily network counts: 2 days.
- Install records: deleted once they are a year old and have had no try-on in the last 90 days.
- Monthly try-on counts for signed-in accounts: 13 months.
- Accounts: deleted once they are a year old and have no monthly counts left.

A cleanup job runs every night to do this.

## Deleting your data

"Delete all my data", at the bottom of the fitting room, removes your photo, results, settings and install key from your browser. It also asks the API to delete your install record and its try-on rows straight away, and your account if you signed in. Removing the extension clears its browser storage too.

## Who else is involved

- The render service you used, as described above.
- Cloudflare, which hosts the API.
- Vercel, which hosts the web page and the demo.
- Google, which runs the Chrome Web Store, and the sign-in if you choose to sign in.

The store whose product you try on doesn't get your photo or your result.

## Children and some US states

Try-On is for people aged 18 and over. We don't offer it to people in Illinois, Texas or Washington State, whose biometric privacy laws we haven't had reviewed yet.

## Chrome Web Store

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Changes

If this notice changes, the date at the top changes too. If a change affects what is sent or kept, the extension and the web page ask you to agree again before your next try-on.
