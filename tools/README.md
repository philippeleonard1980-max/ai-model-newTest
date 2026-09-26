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

## `blend-export.py` + `glb-to-vrm.mjs` — using a character that is not a VRM

Most good anime characters are published as `.blend`, `.fbx` or `.glb`, not as
VRM. They have the bones, but not the *humanoid map* that says which bone is the
left forearm — and without that map `@pixiv/three-vrm` cannot retarget the VRMA
clips onto them, so the avatar would stand in its bind pose forever.

These two steps add the map:

```sh
pip install bpy==4.2.0                                  # Blender as a module
python3 tools/blend-export.py character.blend out.glb   # -> GLB, backdrop removed
node tools/glb-to-vrm.mjs out.glb character.vrm --name "…" --scale 1
npm run render -- --model character.vrm --out check.png # look at it
```

`glb-to-vrm.mjs` matches the rig's bone names against the Maya/FBX convention
(`Name_LeftForeArm_0101`) and refuses rather than guessing if a required bone is
missing. `--scale 0.01` is for rigs authored in centimetres; a human-sized
result should render about 1.5–1.8 m tall.

The VRM metadata it writes is deliberately the most restrictive setting
available — `onlyAuthor`, no redistribution, no commercial use — because the
tool cannot know the source's terms. If you know them, correct the meta block;
do not assume the conservative default is accurate in either direction.

Then load the file with **Personality & Memory → Avatar → Use a .vrm file from
my computer**.
