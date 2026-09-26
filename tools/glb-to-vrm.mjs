#!/usr/bin/env node
/**
 * Wraps a rigged glTF binary in the VRM 1.0 extension, so a character that was
 * never authored as a VRM can still drive the avatar stage.
 *
 * The app renders through `@pixiv/three-vrm` and retargets its VRMA clips onto
 * the VRM humanoid skeleton. A plain GLB — a Sketchfab download, a game-engine
 * export — has the bones but no humanoid map, so nothing can be retargeted onto
 * it. This adds that map by matching the rig's own bone names against the usual
 * Maya/FBX naming, and writes a file the stage loads like any other avatar.
 *
 *   node tools/glb-to-vrm.mjs in.glb out.vrm [--scale 0.01] [--name "…"]
 *                              [--expressions expressions.json]
 *
 * `--expressions` maps VRM expression names onto the rig's morph targets, which
 * is what gives the avatar blinking, lip sync and per-mood faces. Imported rigs
 * usually name their morphs `target_0…target_n`, so the mapping has to be found
 * by looking: render each morph in turn and write down which is which. The file
 * is `{"blink": 8, "aa": {"index": 12, "weight": 0.9}}` — see
 * `resources/expressions/` for a worked example.
 *
 * `--scale` is for rigs authored in centimetres. Check the result with
 * `tools/render.mjs`: a human-sized avatar should come out around 1.5–1.8 m
 * tall. Nothing here invents geometry; if a bone is missing from the rig it is
 * left out of the map, and the tool reports which required ones were not found.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const [input, output] = args.filter((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
if (!input || !output) {
  console.error('usage: glb-to-vrm.mjs <in.glb> <out.vrm> [--scale 1] [--name "Character"] [--author "…"]');
  process.exit(1);
}
const scale = Number(flag('scale', 1));

/**
 * VRM humanoid bone -> a pattern matching the tail of the rig's bone name.
 * Rigs exported through Maya/FBX carry a character prefix and a numeric suffix
 * (`Shibahu_LeftForeArm_0101`), so anchoring on the middle is what generalises.
 */
const HUMANOID = {
  hips: /Hips(_|$)/, spine: /Spine(_|\d*_)$|Spine_\d+$/, chest: /Spine1_/, upperChest: /Spine2_/,
  neck: /Neck_/, head: /Head_/,
  leftShoulder: /LeftShoulder_/, leftUpperArm: /LeftArm_/, leftLowerArm: /LeftForeArm_/, leftHand: /LeftHand_\d+$/,
  rightShoulder: /RightShoulder_/, rightUpperArm: /RightArm_/, rightLowerArm: /RightForeArm_/, rightHand: /RightHand_\d+$/,
  leftUpperLeg: /LeftUpLeg_/, leftLowerLeg: /LeftLeg_/, leftFoot: /LeftFoot_/, leftToes: /LeftToeBase_/,
  rightUpperLeg: /RightUpLeg_/, rightLowerLeg: /RightLeg_/, rightFoot: /RightFoot_/, rightToes: /RightToeBase_/,
};
/** VRM treats these as mandatory; the rest are optional refinements. */
const REQUIRED = new Set([
  'hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg',
  'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
]);

const buf = readFileSync(input);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${input} is not a GLB`);
const jsonLength = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
const binStart = 20 + jsonLength;
const bin = buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart));

const humanBones = {};
const missing = [];
for (const [bone, pattern] of Object.entries(HUMANOID)) {
  const node = gltf.nodes.findIndex((n) => n.name && pattern.test(n.name));
  if (node >= 0) humanBones[bone] = { node };
  else if (REQUIRED.has(bone)) missing.push(bone);
}
if (missing.length > 0) {
  console.error(`Required humanoid bones not found in the rig: ${missing.join(', ')}`);
  console.error('The naming convention differs from the one this tool knows; extend HUMANOID.');
  process.exit(1);
}

// Fingers are optional, but they are what stops the hands looking like mittens.
for (const [side, prefix] of [['left', 'Left'], ['right', 'Right']]) {
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    const joints = finger === 'Thumb'
      ? ['Metacarpal', 'Proximal', 'Distal']
      : ['Proximal', 'Intermediate', 'Distal'];
    joints.forEach((joint, n) => {
      const pattern = new RegExp(`${prefix}Hand${finger}${n + 1}_`);
      const node = gltf.nodes.findIndex((x) => x.name && pattern.test(x.name));
      if (node >= 0) humanBones[`${side}${finger}${joint}`] = { node };
    });
  }
}

// Keep the character root only, and stand it on the origin at the right size.
const roots = gltf.scenes[gltf.scene ?? 0].nodes;
const root = roots.length === 1 ? roots[0] : roots.find((i) => /sketchfab|armature|root|scene/i.test(gltf.nodes[i].name ?? ''));
if (root === undefined) throw new Error(`cannot tell which of ${roots.length} scene roots is the character`);
gltf.scenes[gltf.scene ?? 0].nodes = [root];
const rootNode = gltf.nodes[root];
if (scale !== 1) rootNode.scale = (rootNode.scale ?? [1, 1, 1]).map((v) => v * scale);
rootNode.translation = [0, 0, 0];

/**
 * Bind VRM expression names to morph targets. Every mesh that carries morphs
 * gets the same index bound, because an imported face is usually split across
 * several meshes (skin, brows, mouth interior) that share one morph order.
 */
const preset = {};
const expressionsFile = flag('expressions');
if (expressionsFile) {
  const morphNodes = gltf.nodes
    .map((node, i) => ({ i, mesh: node.mesh }))
    .filter(({ mesh }) => mesh !== undefined && (gltf.meshes[mesh].primitives ?? [])
      .some((p) => (p.targets ?? []).length > 0));
  if (morphNodes.length === 0) throw new Error('--expressions given but the rig has no morph targets');

  for (const [name, value] of Object.entries(JSON.parse(readFileSync(expressionsFile, 'utf8')))) {
    if (name.startsWith('_')) continue;   // a comment key, not an expression
    const { index, weight = 1 } = typeof value === 'number' ? { index: value } : value;
    const binds = morphNodes
      .filter(({ mesh }) => (gltf.meshes[mesh].primitives ?? [])
        .some((p) => (p.targets ?? []).length > index))
      .map(({ i }) => ({ node: i, index, weight }));
    if (binds.length === 0) {
      console.warn(`  expression "${name}": no mesh has morph target ${index}, skipping`);
      continue;
    }
    preset[name] = { morphTargetBinds: binds, isBinary: false, overrideBlink: 'none', overrideLookAt: 'none', overrideMouth: 'none' };
  }
  console.log(`bound ${Object.keys(preset).length} expressions across ${morphNodes.length} meshes`);
}

gltf.extensionsUsed = [...new Set([...(gltf.extensionsUsed ?? []), 'VRMC_vrm'])];
gltf.extensions = {
  ...(gltf.extensions ?? {}),
  VRMC_vrm: {
    specVersion: '1.0',
    // Conservative by default: this tool cannot know the source's terms, so it
    // writes the most restrictive metadata and leaves correcting it to whoever
    // does know them.
    meta: {
      name: flag('name', 'Imported character'),
      version: '1',
      authors: [flag('author', 'unknown')],
      licenseUrl: flag('license-url', 'https://vrm.dev/licenses/1.0/'),
      avatarPermission: 'onlyAuthor',
      allowExcessivelyViolentUsage: false,
      allowExcessivelySexualUsage: false,
      commercialUsage: 'personalNonProfit',
      allowPoliticalOrReligiousUsage: false,
      allowAntisocialOrHateUsage: false,
      creditNotation: 'required',
      allowRedistribution: false,
      modification: 'prohibited',
    },
    humanoid: { humanBones },
    firstPerson: { meshAnnotations: [] },
    lookAt: { type: 'bone' },
    expressions: { preset },
  },
};

const json = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = Buffer.alloc((4 - (json.length % 4)) % 4, 0x20);
const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4, 0);
const total = 12 + 8 + json.length + jsonPad.length + 8 + bin.length + binPad.length;
const out = Buffer.alloc(total);
let at = 0;
const u32 = (v) => { out.writeUInt32LE(v, at); at += 4; };
u32(0x46546c67); u32(2); u32(total);
u32(json.length + jsonPad.length); u32(0x4e4f534a);
json.copy(out, at); at += json.length;
jsonPad.copy(out, at); at += jsonPad.length;
u32(bin.length + binPad.length); u32(0x004e4942);
bin.copy(out, at);
writeFileSync(output, out);

console.log(`wrote ${output} (${(total / 1e6).toFixed(1)} MB) with ${Object.keys(humanBones).length} humanoid bones`);
console.log('Check it before using it:  npm run render -- --model <the .vrm> --out check.png');
