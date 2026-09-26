"""Blender -> GLB, for turning a downloaded character into something the app can use.

Run it with Blender's Python (or the `bpy` PyPI module, which is what CI here
uses):

    pip install bpy==4.2.0
    python3 tools/blend-export.py <input.blend> <output.glb>

It strips the things a Sketchfab-style scene carries around the character — the
flat backdrop disc it sits on, a stray default Cube — and clears any baked
action so the rig exports in its bind pose. `tools/glb-to-vrm.mjs` then wraps
the result in the VRM humanoid extension.
"""

import sys
import bpy
import mathutils


def world_dimensions(obj):
    low = [1e9] * 3
    high = [-1e9] * 3
    for corner in obj.bound_box:
        point = obj.matrix_world @ mathutils.Vector(corner)
        for axis in range(3):
            low[axis] = min(low[axis], point[axis])
            high[axis] = max(high[axis], point[axis])
    return [high[axis] - low[axis] for axis in range(3)]


def main(source, destination):
    bpy.ops.wm.open_mainfile(filepath=source)

    for obj in bpy.data.objects:
        if obj.animation_data:
            obj.animation_data_clear()

    dropped = []
    for obj in [o for o in bpy.data.objects if o.type == 'MESH']:
        size = world_dimensions(obj)
        # A backdrop is flat and wider than the character standing on it.
        if min(size) < 0.05 * max(size) and max(size) > 1.5:
            dropped.append(obj)
    for name in ('Cube',):
        obj = bpy.data.objects.get(name)
        if obj:
            dropped.append(obj)
    for obj in dropped:
        print(f"dropping {obj.name}")
        bpy.data.objects.remove(obj, do_unlink=True)

    bpy.ops.export_scene.gltf(
        filepath=destination, export_format='GLB',
        use_selection=False, export_yup=True, export_apply=False,
        export_animations=False, export_skins=True, export_morph=True,
    )
    print(f"wrote {destination}")


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
