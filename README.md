# Showreel

A minimal, local-first editor for turning images and short clips into a
shareable video sequence.

## Current MVP

- Drag-and-drop or browse for images and video clips
- Preview the sequence directly in the editor
- Reorder items and set an individual duration for each
- Adjust canvas background, padding, fit, and aspect ratio
- Export a silent WebM video in the browser
- Share through the Web Share API when the browser supports file sharing

Media stays in the browser for this version. There is no account, upload
service, database, or server-side rendering pipeline.

## Run locally

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Verify

```bash
pnpm lint
pnpm build
```

The app uses Next.js 16, React 19, native browser media APIs, and no additional
runtime dependencies.
