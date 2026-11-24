"""Independently parse delivered files and recorded media; never modifies CAD geometry."""

import json, pathlib, struct, subprocess, math, collections, os
import pymupdf

root = pathlib.Path(__file__).resolve().parents[1]
d = json.loads((root / "artifacts/final-delivery.json").read_text(encoding="utf-8"))
folder = pathlib.Path(d["folder"])
data = (folder / "mechanical-bracket.stl").read_bytes()
count = struct.unpack_from("<I", data, 80)[0]
assert len(data) == 84 + count * 50
vertices = []
edges = collections.Counter()
volume = 0
for i in range(count):
    values = struct.unpack_from("<12fH", data, 84 + i * 50)
    tri = [tuple(values[j : j + 3]) for j in (3, 6, 9)]
    assert all(math.isfinite(x) for p in tri for x in p)
    vertices.extend(tri)
    for a, b in ((0, 1), (1, 2), (2, 0)):
        edges[tuple(sorted((tri[a], tri[b])))] += 1
    a, b, c = tri
    volume += (
        a[0] * (b[1] * c[2] - b[2] * c[1])
        + a[1] * (b[2] * c[0] - b[0] * c[2])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6
bounds = [max(v[i] for v in vertices) - min(v[i] for v in vertices) for i in range(3)]
assert all(abs(a - b) < 1e-4 for a, b in zip(bounds, d["bounds"]))
assert all(n == 2 for n in edges.values()), "Non-manifold or open mesh"
pdf = pymupdf.open(folder / "dimension-sheet.pdf")
assert len(pdf) == 1
page = pdf[0]
assert len(page.get_drawings()) > 0
page.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5)).save(
    folder / "dimension-sheet-preview.png"
)
ffprobe = os.environ.get("AICAD_FFPROBE", "ffprobe")
video = json.loads(
    subprocess.check_output(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=codec_name,width,height,nb_frames",
            "-of",
            "json",
            d["recording"],
        ],
        text=True,
    )
)
assert float(video["format"]["duration"]) > 10
assert (folder / "mechanical-bracket.dwg").read_bytes()[:6] == b"AC1032"
assert (folder / "mechanical-bracket.dxf").stat().st_size > 1000
report = {
    "stl": {
        "triangles": count,
        "bounds": bounds,
        "closed_manifold_edges": True,
        "mesh_volume": abs(volume),
        "native_volume": d["volume"],
        "mesh_volume_error_percent": abs(abs(volume) - d["volume"]) / d["volume"] * 100,
    },
    "pdf": {"pages": len(pdf), "vector_paths": len(page.get_drawings())},
    "video": video,
    "dwg_header": "AC1032",
    "passed": True,
}
(folder / "file-verification.json").write_text(
    json.dumps(report, indent=2), encoding="utf-8"
)
print(json.dumps(report, indent=2))
