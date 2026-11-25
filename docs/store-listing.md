# Chrome Web Store listing (draft, not submitted)

The package is built with `npm run package -w extension` into `extension/release/`. Build it with
`TRYON_API` and `TRYON_WEB` pointing at the deployed API and web site first; the script warns if
the package still talks to localhost. Submitting needs a Chrome Web Store developer account
(one-time $5 fee).

## Name

Try-On: see clothes on you before you buy

## Short description (132 characters max)

Try clothes from any online store on yourself: a live mirror on your camera, or an AI photo. Your photos stay in your browser.

## Description

Like something on a store page? Open Try-On from the toolbar and see it on you.

Live mirror: turn on your camera and the garment appears on you, following your shoulders and arms as you move. It runs on your computer, and nothing from the camera is sent anywhere.

AI photo: press "Make it real" for a realistic picture of you wearing it. Your photo goes to the render service for that one picture and is deleted there within an hour.

It works on most fashion stores. Use the "Try on" buttons on product photos, right-click an image and choose "Try this on", or drag an image into the panel. Tops, bottoms, dresses, kurtas and 2- and 3-piece suits are recognised.

Your photo and your results are saved only in your browser. There are no ads and no analytics, and "Delete all my data" removes everything.

For people aged 18 and over.

## Category

Shopping

## Privacy practices

- Single purpose: show the user wearing clothes from store pages, as a live camera preview or an AI photo.
- Permissions: see "Permissions" in [extension/README.md](../extension/README.md).
- Data: the user's photo and the chosen garment image are sent to the Try-On API only when the user asks for an AI photo. No browsing history, no personal communications, no location.
- Privacy policy URL: the published `privacy.html` (built from [docs/legal/privacy.md](legal/privacy.md)).
- The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.
