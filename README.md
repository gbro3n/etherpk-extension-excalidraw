# Excalidraw for EtherPK

An [EtherPK](https://etherpk.com) extension for [Excalidraw](https://excalidraw.com) drawings in
your documents. A drawing is kept in the document itself, so it syncs, moves and versions with the
text around it, and you can keep drawing on it whenever you like.

Published by `gbro3n`. This is not an extension from App Software, the makers of EtherPK, nor from
the Excalidraw team.

## What it does

- **`/drawing`** in a document, on a desktop, puts a new drawing at the caret, ready to draw on.
- **Draw in place.** A drawing shows as a picture. Click it to draw, and click outside it, or press
  Done, to go back to the picture. What you draw is saved as you draw.
- **Open in tab** opens the drawing in a tab of its own, with more room.
- **Full window** fills the EtherPK window with the drawing. Press Return to go back. Esc stays with
  Excalidraw, which uses it to leave a tool.
- **Edit as text and Delete** are in the menu at the top right of a drawing's picture (the `…`
  button), and in the bar above a drawing you are drawing on. Edit as text shows the drawing's lines
  in the document. Delete removes the drawing at once. Press Mod+Z in the document to bring it back.
- **Bring a drawing from excalidraw.com.** Paste a share link
  (`https://excalidraw.com/#json=…`) on an empty line, and press **Import this drawing from
  excalidraw.com** on the card that appears. Nothing is fetched from excalidraw.com until you press
  it. The drawing then lives in your document, and the link and its key are gone from it. You can
  also copy shapes on excalidraw.com and paste them on an empty line. Images aren't brought across,
  since a drawing in EtherPK holds none.
- **Phones and tablets under 1024 pixels wide** show drawings as pictures. Tap one to see it bigger.
  Drawing is for a desktop.
- **Published sites.** On a site you publish from EtherPK, a drawing is a picture of it, an SVG file
  with its fonts inside. The drawing's data is never on the site.

What Excalidraw can do that reaches other services is switched off: its library browser, sharing,
web embeds, its AI features and its help and social links. The image tool is off too, since images
belong in EtherPK's own assets.

## How a drawing is stored

A drawing is a fenced block whose info word is `excalidraw.drawing`. Its first line names the
drawing (its own `id`, which lets EtherPK find it again for a tab) and its canvas colour. Each line
after it is one Excalidraw element, as Excalidraw writes it:

````markdown
```excalidraw.drawing
{"type":"excalidraw.drawing","version":1,"id":"k3v9q2m8xa","background":"#ffffff"}
{"id":"r1","type":"rectangle","version":4,"versionNonce":81,"x":0,"y":0,"width":160,"height":80,…}
```
````

Because each element is a line of its own, a change saves only the lines of the elements that
changed, and two devices drawing at once merge element by element.

A save never removes what it didn't load. A line is removed only when you delete that element.
Lines the extension can't read stay as they are: broken JSON, a note in words, or a shape this
Excalidraw doesn't know, such as one made with a newer Excalidraw.

### Writing shapes by hand

A shape can also be written without Excalidraw's bookkeeping, in Excalidraw's own
[skeleton form](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton):
a `type`, a position and a size, and no `version`. A label inside a shape, and an arrow joining two
shapes by their ids, are written the same way:

````markdown
```excalidraw.drawing
{"type":"excalidraw.drawing","version":1,"id":"k3v9q2m8xa","background":"#ffffff"}
{"id":"beds","type":"rectangle","x":0,"y":0,"width":160,"height":80,"label":{"text":"Beds"}}
{"id":"shed","type":"ellipse","x":300,"y":0,"width":120,"height":80,"label":{"text":"Shed"}}
{"type":"arrow","x":160,"y":40,"start":{"id":"beds"},"end":{"id":"shed"}}
```
````

When the drawing is next shown, the extension draws these shapes and writes them back as full
Excalidraw elements in their place. Two devices doing so at once write the same elements.

EtherPK treats a block named `<extension id>.<name>` as an Extension Fence: it never searches it,
never shows its lines unless you ask (Edit as text), and never publishes it as code. Without this
extension, EtherPK shows a note that the drawing comes from the Excalidraw extension, with a button
to show its text. Words written in a drawing aren't found by EtherPK's search yet.

## Terms

- **Drawing**: an `excalidraw.drawing` block, and the picture or live editor the extension draws
  for it.
- **Live drawing**: a drawing open for drawing on, as opposed to its picture. Only one is live in a
  document at a time.

## Installing

It is listed in the EtherPK Extension Directory. Install it in EtherPK from Settings and
Extensions, then Extensions. It needs EtherPK 0.10.0 or later. To try a change before it is
released, install it from a local directory, or side-load it in a development copy of the EtherPK
Client (both below).

## Development

You need Node 24 and pnpm, and a checkout of the EtherPK repository beside this one (`../etherpk`).

```bash
pnpm install
pnpm build          # dist/: main.js, main.css, Excalidraw's code in chunks/, its fonts in fonts/
pnpm test           # unit tests (the drawing format, merging, saving and share links)
pnpm check          # type check
pnpm test:e2e       # browser tests, against a Client that loads this extension
```

To try it in a Client, build it and start the Client's development server with the extension's
folder in `ETHERPK_DEV_EXTENSIONS`:

```bash
# in the EtherPK checkout:
ETHERPK_DEV_EXTENSIONS=/path/to/etherpk-extension-excalidraw pnpm dev:client
```

To install it the way a listed release is installed, build it and serve it from a local Extension
Directory, with the EtherPK checkout's tool:

```bash
# in the EtherPK checkout:
pnpm dev:extension-directory /path/to/etherpk-extension-excalidraw
EXTENSION_DIRECTORY_URL=http://127.0.0.1:5399/directory.json EXTENSION_REGISTRY_URL=http://127.0.0.1:5399 pnpm dev:client
```

The browser tests start their own Client from `ETHERPK_CLIENT_DIR` (`../etherpk` when unset) on
port 5397. On a system where Playwright's own Chromium won't start, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` to another Chromium.

### What the build changes in Excalidraw

Excalidraw 0.18.1 is pinned, with React 19.2.0, and the build (`vite.config.ts`) changes three
things so it runs under the Client's Content Security Policy:

- Excalidraw falls back to loading its fonts from a public CDN, which the Client's policy refuses.
  The build removes that fallback, and `scripts/copy-fonts.mjs` copies the fonts into `dist/fonts`,
  which Excalidraw is told to load them from.
- Excalidraw cuts fonts down to the characters a picture uses with code that calls `new Function`,
  which the policy refuses. The build makes it embed each font whole instead.
- The extension mounts in the page rather than in a shadow root (`"isolation": "page"`), because
  Excalidraw's copy and paste and its dialogs don't work inside one. The Client then accepts only a
  stylesheet whose every rule styles elements with, or inside, a class starting `excalidraw`.
  `scripts/scope-css.ts` scopes Excalidraw's few other rules that way at build time.

The build checks that both changes to Excalidraw's code found the code they change, so a new
Excalidraw release that moves it fails the build rather than shipping without them.

The extension is written against
[`@appsoftwareltd/etherpk-extension-api`](https://www.npmjs.com/package/@appsoftwareltd/etherpk-extension-api).
It uses `context.editor.registerFence` (the widget, the tab and full window, pasting, the published
picture), `context.editor.insertBlock`, `context.layout.isDesktop` and `context.notify`.

## Licence

MIT. See [LICENSE](LICENSE). Excalidraw is MIT licensed by its authors.
