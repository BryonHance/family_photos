"""Exports the vision tower of AvitoTech's CLIP-L, fine-tuned to tell individual
cats and dogs apart, to models/pets/avito_clip_l.onnx for the pet trial run.

    pixi run -e pet-export pet-export

The weights (Apache-2.0, 1.7 GB) come from a pinned revision and are checked
against the safetensors SHA-256 that Hugging Face publishes. The text tower is
dropped. The ONNX model takes CLIP-normalised 224x224 RGB, NCHW, and returns the
768-d image embedding (`get_image_features`), not yet L2-normalised. Before
writing, it checks that the ONNX output matches PyTorch on a random input.
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime
import torch
from transformers import CLIPModel

REPO = "AvitoTech/Zer0int-CLIP-L-for-animal-identification"
REVISION = "f50a193d334e5da92bd23e7c5c03c4baabb4916f"
SAFETENSORS_SHA256 = "e83c726bdcf17b07ad89a8edf7a6c9b0a081d4ac459692b2f89c9e08994e8646"

models = Path(__file__).resolve().parent.parent.parent / "models" / "pets"
cache = models / "avito-source"
out = models / "avito_clip_l.onnx"


def fetch(name: str) -> None:
    path = cache / name
    if path.exists():
        return
    url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}"
    print(f"Downloading {url}")
    urllib.request.urlretrieve(url, path.with_suffix(".part"))
    path.with_suffix(".part").rename(path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ImageEmbedding(torch.nn.Module):
    def __init__(self, clip: CLIPModel):
        super().__init__()
        self.vision = clip.vision_model
        self.projection = clip.visual_projection

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        return self.projection(self.vision(pixel_values=pixel_values).pooler_output)


cache.mkdir(parents=True, exist_ok=True)
for name in ("config.json", "model.safetensors"):
    fetch(name)
if sha256(cache / "model.safetensors") != SAFETENSORS_SHA256:
    sys.exit("model.safetensors does not match its pinned SHA-256; refusing to use it.")

clip = CLIPModel.from_pretrained(cache).eval()
model = ImageEmbedding(clip).eval()
example = torch.randn(1, 3, 224, 224)
with torch.no_grad():
    expected = model(example).numpy()
    reference = clip.get_image_features(pixel_values=example)
    if hasattr(reference, "pooler_output"):
        reference = reference.pooler_output
    assert np.allclose(expected, reference.numpy(), atol=1e-5), "wrapper differs from get_image_features"
    torch.onnx.export(
        model,
        (example,),
        str(out),
        input_names=["pixel_values"],
        output_names=["image_embeds"],
        dynamic_axes={"pixel_values": {0: "batch"}, "image_embeds": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )

session = onnxruntime.InferenceSession(str(out), providers=["CPUExecutionProvider"])
actual = session.run(None, {"pixel_values": example.numpy()})[0]
if not np.allclose(actual, expected, atol=1e-3):
    out.unlink()
    sys.exit(f"ONNX output differs from PyTorch (max {np.abs(actual - expected).max():.2e}); removed {out}.")
print(f"Wrote {out} ({out.stat().st_size / 1e6:.0f} MB); ONNX matches PyTorch.")
print(f"You can delete {cache} now.")
