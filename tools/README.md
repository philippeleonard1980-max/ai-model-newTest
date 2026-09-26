# tools/

## `render.mjs` — headless avatar renderer

Loads a `.vrm` (optionally posed by a `.vrma` clip) in headless Chromium using
the same three.js + `@pixiv/three-vrm` stack the app uses, and writes a PNG.

It exists to answer two questions without launching the whole app:

- *Does this avatar actually look the way its metadata claims?* Bone names lie —
  fox ears and tails are often mesh-only with no distinctly named node, so the
  only reliable check is to look.
- *Do the VRMA clips retarget onto this avatar?* If the rendered bounding box
  narrows from the T-pose width, the arms came down and retargeting worked.

Needs Playwright, which is deliberately not an app dependency:

```sh
npm i -D playwright
npm run render -- --model assets/models/vroid-sample-girl.vrm --out shot.png
npm run render -- --model assets/models/megan-the-fox.vrm \
                  --anim assets/animations/thinking.vrma --time 1.4 \
                  --view head --out head.png
```

| flag | meaning |
|---|---|
| `--model` | path to the `.vrm`, relative to the repo root |
| `--anim` | optional `.vrma` clip to pose it with |
| `--time` | seconds into the clip to sample (default 0) |
| `--view` | `full` (default) or `head` |
| `--yaw` | camera rotation in degrees |
| `--width` / `--height` | output size |
| `--out` | output PNG path |

The renders in `docs/preview/` were produced with this.
