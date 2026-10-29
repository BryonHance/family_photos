"""Exports the vision tower of AvitoTech's CLIP-L, fine-tuned to tell individual
cats and dogs apart, to avito_clip_l.onnx in models/pets/ (or the directory given
as the first argument), and records its SHA-256 beside it in avito_clip_l.onnx.sha256.

    pixi run -e pet-export pet-export [dest]

`pixi run models` runs it through scripts/export-pet-models.sh, and the Dockerfile
runs it in a build stage, so PyTorch never enters the app's environment or image.

The weights (Apache-2.0, 1.7 GB) come from a pinned revision and are checked
against the safetensors SHA-256 that Hugging Face publishes. They are downloaded
into a hidden directory beside the output and deleted once the export succeeds.
The text tower is dropped. The ONNX model (fp32) takes CLIP-normalised 224x224
RGB, NCHW, and returns the 768-d image embedding (`get_image_features`), not yet
L2-normalised. It fails unless the ONNX output matches PyTorch within 1e-3 on a
fixed input.
"""

import hashlib
import shutil
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
TOLERANCE = 1e-3

dest = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "models" / "pets"
cache = dest / ".avito-source"
out = dest / "avito_clip_l.onnx"
partial = dest / "avito_clip_l.onnx.part"
recorded = dest / "avito_clip_l.onnx.sha256"


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


# A stale record must never vouch for a new export, so it goes first.
recorded.unlink(missing_ok=True)
cache.mkdir(parents=True, exist_ok=True)
for name in ("config.json", "model.safetensors"):
    fetch(name)
if sha256(cache / "model.safetensors") != SAFETENSORS_SHA256:
    (cache / "model.safetensors").unlink()
    sys.exit("model.safetensors does not match its pinned SHA-256; removed it, refusing to use it.")

clip = CLIPModel.from_pretrained(cache).eval()
model = ImageEmbedding(clip).eval()
# A fixed input, so that the check is the same on every build.
example = torch.randn(1, 3, 224, 224, generator=torch.Generator().manual_seed(0))
with torch.no_grad():
    expected = model(example).numpy()
    reference = clip.get_image_features(pixel_values=example)
    if hasattr(reference, "pooler_output"):
        reference = reference.pooler_output
    assert np.allclose(expected, reference.numpy(), atol=1e-5), "wrapper differs from get_image_features"
    assert expected.shape == (1, 768), f"expected a 768-d embedding, got {expected.shape}"
    torch.onnx.export(
        model,
        (example,),
        str(partial),
        input_names=["pixel_values"],
        output_names=["image_embeds"],
        dynamic_axes={"pixel_values": {0: "batch"}, "image_embeds": {0: "batch"}},
        opset_version=17,
        dynamo=False,
    )

session = onnxruntime.InferenceSession(str(partial), providers=["CPUExecutionProvider"])
actual = session.run(None, {"pixel_values": example.numpy()})[0]
del session
difference = float(np.abs(actual - expected).max())
if difference > TOLERANCE:
    partial.unlink()
    sys.exit(f"ONNX output differs from PyTorch by {difference:.2e}, more than {TOLERANCE:g}; refusing to use it.")
partial.replace(out)
# In sha256sum's format, read by the server's startup check and by `sha256sum --check`.
recorded.write_text(f"{sha256(out)}  {out.name}\n")
shutil.rmtree(cache)
print(f"Wrote {out} ({out.stat().st_size / 1e6:.0f} MB); ONNX matches PyTorch within {difference:.2e}.")
