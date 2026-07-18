"""Split the material-merged V-22 propellers into two pivoted GLB objects.

Run with Blender, not CPython:
  blender --background --factory-startup --python tools/rig_v22_rotors.py

The source asset is preserved. The generated asset is validated by re-importing it and
checking polygon counts, rotor names, hub pivots, and byte-identical embedded textures
before the script exits successfully.
"""

import argparse
import bpy
import hashlib
import json
import math
import struct
import sys
from collections import defaultdict, deque
from pathlib import Path
from mathutils import Vector


WEBSERVER_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = WEBSERVER_DIR / "public/models/v22_osprey.glb"
DEFAULT_OUTPUT = WEBSERVER_DIR / "public/models/v22_osprey_rotors.glb"
EXPECTED_SOURCE_SHA256 = "138e5d78a091fa94a5c9990c3cffb792743f9731733d1fc28a525befcbe3f68c"
SOURCE_OBJECTS = ("Object_5", "Object_7")
# Coordinates are in the source mesh's glTF-local space. The two hub positions were
# measured from the symmetric spinner components, not inferred from whole-object bounds.
HUBS = {
    "Left": Vector((-1.573614, -2.521972, 7.041000)),
    "Right": Vector((-1.573616, -2.521972, -7.041000)),
}
AXIAL_TOLERANCE = 0.8
ROTOR_RADIUS = 6.25


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--allow-source-change", action="store_true")
    blender_args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    return parser.parse_args(blender_args)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def glb_payload(path):
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise RuntimeError(f"Not a binary glTF: {path}")
    offset = 12
    document = None
    binary = None
    while offset < len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8:offset + 8 + chunk_length]
        if chunk_type == 0x4E4F534A:
            document = json.loads(chunk.rstrip(b"\x00 \t\r\n"))
        elif chunk_type == 0x004E4942:
            binary = chunk
        offset += 8 + chunk_length
    if document is None or binary is None:
        raise RuntimeError(f"GLB is missing JSON or BIN data: {path}")
    return document, binary


def embedded_image_hashes(path):
    document, binary = glb_payload(path)
    hashes = []
    for image in document.get("images", []):
        view = document["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        payload = binary[start:start + view["byteLength"]]
        hashes.append(hashlib.sha256(payload).hexdigest())
    return sorted(hashes)


def connected_components(mesh):
    adjacency = defaultdict(set)
    for edge in mesh.edges:
        first, second = edge.vertices
        adjacency[first].add(second)
        adjacency[second].add(first)
    unseen = set(range(len(mesh.vertices)))
    output = []
    while unseen:
        start = unseen.pop()
        queue = deque([start])
        component = [start]
        while queue:
            current = queue.popleft()
            for neighbor in adjacency[current]:
                if neighbor in unseen:
                    unseen.remove(neighbor)
                    queue.append(neighbor)
                    component.append(neighbor)
        output.append(component)
    return output


def component_is_rotor(mesh, indices, hub):
    coordinates = [mesh.vertices[index].co for index in indices]
    axial_max = max(abs(coordinate.y - hub.y) for coordinate in coordinates)
    radial_max = max(
        math.hypot(coordinate.x - hub.x, coordinate.z - hub.z)
        for coordinate in coordinates
    )
    return axial_max <= AXIAL_TOLERANCE and radial_max <= ROTOR_RADIUS


def separate_rotor_part(source, side, hub):
    mesh = source.data
    selected = {
        index
        for component in connected_components(mesh)
        if component_is_rotor(mesh, component, hub)
        for index in component
    }
    if not selected:
        raise RuntimeError(f"No {side} rotor vertices found in {source.name}")
    before = set(bpy.data.objects)
    bpy.ops.object.select_all(action="DESELECT")
    source.select_set(True)
    bpy.context.view_layer.objects.active = source
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for vertex in mesh.vertices:
        vertex.select = vertex.index in selected
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    created = list(set(bpy.data.objects) - before)
    if len(created) != 1:
        raise RuntimeError(
            f"Expected one separated {side} object from {source.name}, got {len(created)}"
        )
    part = created[0]
    part.name = f"V22_Rotor_{side}_{source.name}"
    print("V22_ROTOR_PART", side, source.name, len(part.data.vertices), len(part.data.polygons))
    return part


def join_parts(parts, side, hub):
    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    active = parts[0]
    bpy.context.view_layer.objects.active = active
    bpy.ops.object.join()
    active.name = f"V22_Rotor_{side}"
    parent = active.parent
    bpy.context.scene.cursor.location = parent.matrix_world @ hub if parent else hub
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR", center="MEDIAN")
    print("V22_ROTOR_JOINED", side, len(active.data.vertices), len(active.data.polygons))
    return active


def mesh_totals():
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    return (
        sum(len(obj.data.vertices) for obj in meshes),
        sum(len(obj.data.polygons) for obj in meshes),
    )


def validate_export(output, expected_polygons, expected_image_hashes):
    if embedded_image_hashes(output) != expected_image_hashes:
        raise RuntimeError("Exported GLB changed or dropped embedded texture images")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(output))
    exported_rotors = [
        bpy.data.objects.get("V22_Rotor_Left"),
        bpy.data.objects.get("V22_Rotor_Right"),
    ]
    if any(rotor is None or rotor.type != "MESH" for rotor in exported_rotors):
        raise RuntimeError("Exported GLB is missing V22_Rotor_Left or V22_Rotor_Right")
    if mesh_totals()[1] != expected_polygons:
        raise RuntimeError(
            f"Exported polygon count changed: {expected_polygons} -> {mesh_totals()[1]}"
        )
    for rotor, hub in zip(exported_rotors, HUBS.values()):
        if (rotor.location - hub).length > 1e-4:
            raise RuntimeError(f"Exported pivot moved for {rotor.name}: {list(rotor.location)}")
        if len(rotor.data.polygons) != 2622:
            raise RuntimeError(
                f"Unexpected geometry in {rotor.name}: {len(rotor.data.polygons)} polygons"
            )
    print("V22_EXPORT_VALIDATED", [(rotor.name, list(rotor.location)) for rotor in exported_rotors])


def main():
    args = parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if source == output:
        raise RuntimeError("Refusing to overwrite the source V-22 GLB")
    source_digest = sha256(source)
    source_image_hashes = embedded_image_hashes(source)
    if not args.allow_source_change and source_digest != EXPECTED_SOURCE_SHA256:
        raise RuntimeError(
            f"Source SHA-256 changed; inspect before regenerating: {source_digest}"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    before_vertices, before_polygons = mesh_totals()
    parts = {side: [] for side in HUBS}
    for source_name in SOURCE_OBJECTS:
        source_object = bpy.data.objects.get(source_name)
        if source_object is None or source_object.type != "MESH":
            raise RuntimeError(f"Missing expected mesh {source_name}")
        for side, hub in HUBS.items():
            parts[side].append(separate_rotor_part(source_object, side, hub))
    rotors = [join_parts(parts[side], side, hub) for side, hub in HUBS.items()]
    after_vertices, after_polygons = mesh_totals()
    if (before_vertices, before_polygons) != (after_vertices, after_polygons):
        raise RuntimeError(
            "Separation changed source geometry totals: "
            f"{before_vertices}/{before_polygons} -> {after_vertices}/{after_polygons}"
        )
    for rotor in rotors:
        rotor.rotation_euler.y = 0.0
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_animations=False,
    )
    validate_export(output, before_polygons, source_image_hashes)
    print("V22_RIG_COMPLETE", output, sha256(output))


main()
