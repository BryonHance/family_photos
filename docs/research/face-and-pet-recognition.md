# Face and pet recognition: one model, or a second pipeline for pets?

**Question:** Is there a model, or a pipeline of models, that recognises both human faces and individual pets (dogs, cats, etc.), so a family's pets can be named and recognised across Photos the same way a Person is? It has to fit the same constraints: Node.js/TypeScript backend, `onnxruntime-node` on a home-server CPU in Docker, weights fetched at build time and never at runtime.
**Researched:** 2026-10-26. This note builds on [`face-recognition-on-cpu.md`](./face-recognition-on-cpu.md) and does not repeat its human-face material. Sources are primary (repos, model cards, papers, licence files, app source) unless marked **[unverified]** or **[secondary]**. No benchmarks were run for this note; every number comes from the source it is credited to.

---

## 1. Recommendation

**No single model does both jobs. Keep the face pipeline as it is (`buffalo_sc`) and add a separate pet pipeline beside it.** The only model found that *detects* human and animal faces together is AnyFace, a YOLOv5l6-face model that outputs boxes and 5 landmarks for any face (human, animal, cartoon), released as a PyTorch `.pt` ([IS2AI/AnyFace](https://github.com/IS2AI/AnyFace)). No model was found that *identifies* both people and individual animals. The identity models are split: ArcFace-style models trained on human faces, and animal re-ID models trained on animals (§3). The app that is furthest along, a closed Immich PR, also added a second detector and recogniser for pets next to the face models ([immich#28297](https://github.com/immich-app/immich/pull/28297)).

**Proposed pet pipeline (all weights permissive):**
1. **Detector: D-FINE-S trained on COCO only (Apache-2.0).** It finds `cat` and `dog` (and other COCO animals) as whole-body boxes, with COCO AP 48.5 at 10M params ([D-FINE README](https://github.com/Peterande/D-FINE)). The repo ships an ONNX export that includes post-processing, so there is no NMS to write (`images`, `orig_target_sizes` → `labels`, `boxes`, `scores`; [export_onnx.py](https://github.com/Peterande/D-FINE/blob/master/tools/deployment/export_onnx.py)). The lightest option with a published CPU figure is **NanoDet-Plus-m-1.5x (Apache-2.0)**: COCO AP 34.1, 2.44M params, 11.50 ms on an i7-8700 with OpenVINO ([NanoDet README](https://github.com/RangiLyu/nanodet)).
2. **Embedding: AvitoTech's CLIP-L fine-tuned for cat and dog identification (Apache-2.0).** It is the only pet-trained identity model found with permissive weights and published pet results. It reaches Top-1 0.8768 on Cat Individual Images and 0.6289 on DogFaceNet, ahead of frozen MegaDescriptor-L-384 (0.8421 / 0.4607) ([model card](https://huggingface.co/AvitoTech/Zer0int-CLIP-L-for-animal-identification); [arXiv 2603.02270](https://arxiv.org/html/2603.02270v1), Tables 25–26). The costs: a 1.71 GB safetensors file (HF API), no ONNX, and training data that includes PetFace, which its authors release "for research purposes only" (§6).
3. **Lighter fallback embedding: DINOv2 ViT-S/14 (Apache-2.0, 21M params; [dinov2](https://github.com/facebookresearch/dinov2)).** A community ONNX export is 88.5 MB in fp32 and 24.4 MB in int8 ([onnx-community/dinov2-small-ONNX](https://huggingface.co/onnx-community/dinov2-small-ONNX)) **[secondary: third-party conversion]**. No published result shows how well a *frozen* DINOv2-S tells pets apart (§2.3).

**Are general embeddings good enough? At benchmark scale, no.** On PetFace's unseen-individual verification, frozen CLIP scores AUC 85.10 on cats and 91.86 on dogs. A ResNet-50 ArcFace trained on PetFace scores 97.71 and 99.45 ([PetFace, Table 3](https://arxiv.org/pdf/2407.13555v2)). On 29 wildlife datasets, frozen DINOv2 ViT-L lags MegaDescriptor on every one ([WildlifeDatasets, Table 4](https://arxiv.org/pdf/2311.09118)). However, those benchmarks match against thousands of individuals, while a family has a handful of pets and confirms every Suggestion. Whether a general embedding separates *your* pets is untested. PhotoPrism's maintainer names the hard case: "ideally one that can separate my two black cats" ([photoprism#1561](https://github.com/photoprism/photoprism/issues/1561#issuecomment-928928739)). **Before building the feature, run a short spike on a few hundred family Photos with both embeddings.** LibrePhotos' maintainer proposed the same spike four days ago ([librephotos#548](https://github.com/LibrePhotos/librephotos/issues/548)).

**Trial run on our own pets (2026-10-26, §8):** on 20 Photos of our five pets, Avito CLIP-L matched every Photo to the right pet. At a cut-off of 0.65 it accepted 94 % of same-pet pairs and no different-pet pairs. DINOv2-S at its own clean cut-off (0.60) accepted only 52 %. Avito CLIP-L stays the recommendation, but the sample is too small to set a threshold.

**Domain and ADR, flagged:** a pet is neither a Face nor a Person as `GLOSSARY.md` defines them, so new terms are needed. ADR-0002's exception to "never retained" covers *face* data only, so keeping pet embeddings needs ADR-0002 widened or a new ADR (§7).

---

## 2. Comparison tables

### 2.1 Pet (animal) detectors

All AP figures are COCO val2017 mAP 0.5:0.95 unless marked. GPU latencies are listed only to rank the models; CPU figures name their hardware.

| Detector | Params | COCO AP | Published latency | ONNX | Weights licence | Last push |
|---|---|---|---|---|---|---|
| **D-FINE-N / -S / -M** (COCO) | 4M / 10M / 19M | 42.8 / 48.5 / 52.3 | 2.12 / 3.49 / 5.62 ms, T4 TensorRT fp16 | official export script; community ONNX 15.3 / 41.5 MB (N / S, fp32)³ | Apache-2.0 (COCO-only checkpoints)¹ | 2026-10-05 |
| **NanoDet-Plus-m-1.5x** | 2.44M | 34.1 @416 | **11.50 ms, i7-8700 CPU (OpenVINO)**; 41.02 ms, i7-12700K (OpenCV DNN)² | official; OpenCV Zoo ONNX 3.8 MB | Apache-2.0 | 2024-08 |
| **YOLOX-S** | 9.0M | 40.5 | **78.77 ms, i7-12700K (OpenCV DNN)**² | official demo; OpenCV Zoo ONNX 35.9 MB | Apache-2.0 | 2025-06 |
| YOLOX-Nano / Tiny | 0.91M / 5.06M | 25.8 / 32.8 @416 | — | official | Apache-2.0 | 2025-06 |
| RT-DETR-R18 / RT-DETRv2-S | 20M | 46.5 / 48.1 | 217 FPS, T4 | onnxruntime supported | Apache-2.0 | 2026-10-09 |
| RF-DETR-N / -S | 30.5M / 32.1M | 48.4 / 53.0 | 2.3 / 3.5 ms, T4 TensorRT fp16 | community ONNX (base: 107.8 MB)³ | Apache-2.0 (N–L only; A/F/P/XL/2XL are "PML 1.0") | 2026-10-26 |
| MegaDetector V6 `MDV6-apa-rtdetr-c` / `-mit-yolov9-c` | 20M / 9.7M | animal recall 81.1 % / 74.8 %, mAP50 91.0 / 87.6 (MD's own validation sets) | MDV6-yolov10-c: "~2–5" images/s on a "modern CPU" | none mentioned | Apache-2.0 / MIT; other V6 variants AGPL-3.0 | — |
| Ultralytics YOLO11n / s | 2.6M / 9.4M | 39.5 / 47.0 | 56.1 / 90.0 ms "CPU ONNX" (CPU not named) | official | **AGPL-3.0** or Enterprise | 2026-10-26 |
| OWLv2 base (open vocabulary) | — | — | none published | community ONNX 614 MB fp32 / 155 MB int8³ | Apache-2.0 | 2024-10 |
| Grounding DINO tiny (open vocabulary) | — | — | none published | community ONNX 719 MB fp32 / 204 MB int8³ | Apache-2.0 | 2024-08 |
| AnyFace (human + animal **faces**, 5 landmarks) | YOLOv5l6 | not stated in README | — | **none** (`.pt` on Google Drive) | repo MIT, but built on GPL-3.0 `yolov5-face` **[licence intent unclear]** | 2023-08 |
| dlib `mmod_dog_hipsterizer` (dog faces, 6 landmarks) | — | — | — | **none** (dlib `.dat`) | CC0 repo; trained on Columbia Dogs | 2025-05 |

Sources: [D-FINE README](https://github.com/Peterande/D-FINE), [NanoDet README](https://github.com/RangiLyu/nanodet), [YOLOX README](https://github.com/Megvii-BaseDetection/YOLOX), [RT-DETR README](https://github.com/lyuwenyu/RT-DETR), [RF-DETR README](https://github.com/roboflow/rf-detr), [MegaDetector model zoo](https://microsoft.github.io/MegaDetector/model_zoo/) and [MegaDetector docs](https://microsoft.github.io/MegaDetector/), [Ultralytics YOLO11 docs](https://docs.ultralytics.com/models/yolo11/), [AnyFace](https://github.com/IS2AI/AnyFace), [dlib-models](https://github.com/davisking/dlib-models), [dlib dog example](http://dlib.net/dnn_mmod_dog_hipsterizer.cpp.html). Licences and push dates are from the GitHub API, and HF licences and sizes from the HF API, both read on 2026-10-26.
¹ D-FINE: "Checkpoints trained or pretrained on Objects365 (*_obj365, *_obj2coco) may be subject to the Objects365 dataset terms and should not be assumed to be commercially cleared under the D-FINE license" ([README](https://github.com/Peterande/D-FINE)). Use the `*_coco` checkpoints.
² [OpenCV Zoo benchmark](https://github.com/opencv/opencv_zoo/blob/main/benchmark/README.md): mean ms, OpenCV DNN CPU backend. YOLOX at 640×640, NanoDet at 416×416. The same i7-12700K runs SFace at 5.09 ms in the earlier note, so the figures compare directly.
³ Conversions published by `onnx-community`/`Xenova`, not by the model owners **[secondary]**.

### 2.2 Individual-animal embedding (re-ID) models

| Model | Arch / params | Trained on | Input | Weights format / size | Weights licence | Pet results published |
|---|---|---|---|---|---|---|
| **AvitoTech Zer0int CLIP-L** | CLIP ViT-L/14, 0.4B, 768-d | PetFace + Dogs-World + LCW + web; 1.90M photos, 695,091 cats and dogs | 224, body or face crop | safetensors 1.71 GB, no ONNX | **Apache-2.0** (training data includes research-only PetFace, §6) | yes (§2.3, §3.3) |
| PetFace ArcFace (per family / joint) | ResNet-50 | PetFace: 1,012,934 images, 257,484 individuals, 13 families | 224, **aligned face** (AnyFace 5 points) | `.pt` on Google Drive | **"non-commercial research purpose only"**, no LICENSE file | yes (§3.2) |
| MegaDescriptor-L-384 / B-224 / T-224 | Swin-L 228.8M / Swin-B / Swin-T | 29 wildlife re-ID datasets (no domestic cats; DogFaceNet added 2024) | 384 / 224 | PyTorch `.bin` 1,935 / 473 / 204 MB, no ONNX | **CC BY-NC 4.0** | yes, frozen (§2.3) |
| MiewID-msv3 | EfficientNetV2-M, 51.1M, 24.38 GMACs | 64 wildlife groups incl. `dog` (DogFaceNet); no domestic cat | 440 | safetensors 206 MB, `custom_code` | **none stated** (no licence on HF card or GitHub) | yes, frozen (§2.3) |
| DogFaceNet | ResNet + triplet loss (2019) | web-scraped dog faces, 3-point alignment | face | TF 1.12 code | MIT code | own paper only |
| DINOv2 ViT-S/14 (general) | 21M | LVD-142M (self-supervised) | 224 (patch 14) | community ONNX 88.5 MB fp32 / 24.4 MB int8 | **Apache-2.0** | only fine-tuned (§2.3) |
| DINOv3 ViT-S/16 (general) | 21M | LVD-1689M | 224 (patch 16) | safetensors 86.4 MB, gated | "DINOv3 License" (custom; "Built with DINOv3" on redistribution) | none found |
| SigLIP2 base (general) | — | WebLI | 224 | full ONNX 1.5 GB fp32; Immich's vision-only ONNX 372 MB | Apache-2.0 | only fine-tuned (§2.3) |
| OpenAI CLIP ViT-B/32 (general) | — | WIT | 224 | Immich's vision ONNX 352 MB | MIT (OpenAI CLIP) **[licence not re-read for this note]** | frozen on PetFace (variant not stated) |

Sources: [AvitoTech card](https://huggingface.co/AvitoTech/Zer0int-CLIP-L-for-animal-identification), [PetFace repo](https://github.com/mapooon/PetFace) and [paper](https://arxiv.org/pdf/2407.13555v2), [MegaDescriptor-L-384 card](https://huggingface.co/BVRA/MegaDescriptor-L-384), [MiewID-msv3 card](https://huggingface.co/conservationxlabs/miewid-msv3), [wbia-plugin-miew-id](https://github.com/WildMeOrg/wbia-plugin-miew-id), [DogFaceNet](https://github.com/GuillaumeMougeot/DogFaceNet), [DINOv2](https://github.com/facebookresearch/dinov2), [DINOv3](https://github.com/facebookresearch/dinov3) and [DINOv3 License](https://ai.meta.com/resources/models-and-libraries/dinov3-license/), [Immich SigLIP2 ONNX](https://huggingface.co/immich-app/ViT-B-16-SigLIP2__webli), [Immich CLIP ONNX](https://huggingface.co/immich-app/ViT-B-32__openai). Sizes and licences are from the HF API.

### 2.3 General vs dedicated embeddings: the published evidence

| Source | Setting | General model(s) | Dedicated model(s) | Result |
|---|---|---|---|---|
| [PetFace, Table 3](https://arxiv.org/pdf/2407.13555v2) | Verification of **unseen** individuals, aligned face crops, AUC % | ImageNet: cat 81.58 / dog 97.18 / avg 79.60. CLIP: 85.10 / 91.86 / 78.63 | MegaDescriptor: 87.30 / 93.75 / 83.70. ArcFace on PetFace (per family): 97.71 / 99.45 / 91.30. Joint: 98.04 / 99.01 / 92.17 | Pet-trained ArcFace clearly best. MegaDescriptor (wildlife) beats CLIP |
| [PetFace, §5 "Fine-grained verification"](https://arxiv.org/pdf/2407.13555v2) | Same-breed dog pairs, top-10 breeds, mean AUC % | ImageNet 84.99, CLIP 80.78 | MegaDescriptor 86.25; PetFace model 98.30 | General models drop most when breeds match |
| [WildlifeDatasets, Table 4](https://arxiv.org/pdf/2311.09118) | 29 wildlife datasets, accuracy % | DINOv2 ViT-L/14-518, e.g. CTai 68.70, IPanda50 62.84, MacaqueFaces 91.56 | MegaDescriptor-L-384: 91.10, 86.91, 99.04 | MegaDescriptor "outperforms all methods on all 29 datasets". **Caveat:** MegaDescriptor was trained on those datasets' training splits, so this is not a like-for-like zero-shot comparison |
| [arXiv 2603.02270, Tables 25–26](https://arxiv.org/html/2603.02270v1) | Cats (Cat Individual Images) and dogs (DogFaceNet), **frozen** models, Top-1 | BioCLIP: cat 0.8473 / dog 0.3720 | MiewID-msv3: 0.8723 / 0.5569. MD-L-384: 0.8421 / 0.4607 | Frozen wildlife models are mediocre on dogs |
| [AvitoTech card](https://huggingface.co/AvitoTech/Zer0int-CLIP-L-for-animal-identification) (same paper) | Same test sets, encoders **fine-tuned** (last 5 blocks) on 1.9M pet photos, Top-1 | DINOv2-Small 0.8547 / 0.5581. SigLIP2-Base 0.8660 / 0.5925. SigLIP2-Giant 0.8899 / 0.7475 | Released Zer0int CLIP-L 0.8768 / 0.6289 | Once fine-tuned on pets, the backbone matters less than the data. Only the CLIP-L weights are released |

**Reading.** Every published comparison has a dedicated or pet-trained model ahead of a frozen general one, often by a wide margin. None of them measures the family case (one to five pets, a human confirming each match), so these numbers set a ceiling on difficulty, not a verdict for this app. No published frozen-DINOv2 or DINOv3 result on cats or dogs was found.

---

## 3. Per-model notes

### 3.1 Is there one model for both? (Q1)
- **AnyFace** is "input-agnostic" face detection trained on WIDER Face, AnimalWeb, iCartoonFace and TFW, with 5 landmarks (eyes, nose, mouth corners) ([README](https://github.com/IS2AI/AnyFace)). PetFace used it to align every animal face ([paper §3.3](https://arxiv.org/pdf/2407.13555v2)). It only detects. Identification still needs separate human and animal embeddings. It ships as a PyTorch YOLOv5l6 at 800 px with no accuracy numbers in the README and no ONNX. The repo LICENSE is MIT, but it builds on `deepcam-cn/yolov5-face`, which is GPL-3.0 (GitHub API). It would also be a heavier detector than SCRFD-500MF for the human faces. **Not recommended** as a replacement.
- **Identity:** no published model was found that embeds human faces *and* individual animals in one space. InsightFace's new 2.x `cheetah` packs add *person* (body) re-ID, but reuse the buffalo face models ([model_zoo.md](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#cheetah-person-analysis-packages), already covered in the earlier note). A general backbone such as DINOv2 or CLIP *can* embed both, but for human faces it would replace ArcFace, whose results the earlier note covers, with an untested general embedding. That makes no sense when `buffalo_sc` already works.
- **Side effect worth knowing:** human face detectors sometimes fire on pets. An Immich user: "dogs get picked up with the 'people' facial recognition but cats don't" ([immich#7151](https://github.com/immich-app/immich/discussions/7151)). A PhotoPrism user saw a dog and a cat matched as faces ([photoprism#1561](https://github.com/photoprism/photoprism/issues/1561)). This is anecdotal **[not measured for SCRFD-500MF]**, but it means a pet pipeline should deal with a Face that sits inside a dog's box (§7).

### 3.2 PetFace (ECCV 2024)
- Data: 1,012,934 images, 257,484 individuals, 13 families (cat, chimp, chinchilla, degus, dog, ferret, guinea pig, hamster, hedgehog, parakeet, Java sparrow, pig, rabbit). Images were scraped from pet-shop and animal-adoption sites, cropped to 224×224 and aligned with species-specific landmark templates ([paper §3](https://arxiv.org/pdf/2407.13555v2)).
- Backbone ResNet-50. ArcFace beat Softmax, Center and Triplet. ResNet-50 also beat ViT-B/32 and Swin-B as the backbone, with mean AUC 91.30 against 83.35 and 83.17 ([paper, Table 5](https://arxiv.org/pdf/2407.13555v2)).
- Re-identification Top-1 (seen individuals, against a gallery of 113,592 cat and 46,755 dog classes): cat 54.29 → 70.30 joint, dog 77.86 → 68.75 joint ([Table 2](https://arxiv.org/pdf/2407.13555v2)). These are far harder than a family gallery.
- Licence: the repo has no LICENSE file. Its README warns "for non-commercial research purpose only" for dataset, code and models ([repo](https://github.com/mapooon/PetFace)). The project page says "This dataset is for research purposes only" and gates the data behind a form ([PetFace page](https://dahlian00.github.io/PetFacePage/)). Weights are `.pt` files on Google Drive.
- Practical cost: it needs AnyFace landmarks (above) for alignment, so it adds a second, GPL-derived PyTorch detector. That only works when the pet's face is visible and roughly frontal.

### 3.3 Dedicated and fine-tuned re-ID models
- **AvitoTech Zer0int CLIP-L** (HF card updated 2026-08-12). It fine-tunes `zer0int/CLIP-GmP-ViT-L-14` with triplet loss plus a variance term, unfreezing the last 5 blocks. Its 768-d output is L2-normalised ([card](https://huggingface.co/AvitoTech/Zer0int-CLIP-L-for-animal-identification)). Combined test set: ROC AUC 0.9842, EER 0.0565, Top-1 0.7626 (same card). The paper's headline gated SigLIP2-Giant + text fusion (Top-1 84.28 %) is not released as weights **[per the card; the paper's data-availability section was not read]**. The paper says the splits keep "animal identity separation", but reports no explicit overlap check ([arXiv 2603.02270](https://arxiv.org/html/2603.02270v1)). No CPU latency is published. It is a ViT-L, so expect it to dominate request time **[unmeasured]**.
- **MegaDescriptor** (BVRA, WACV 2024). Swin-based and trained with ArcFace on "all available animal re-identification datasets" ([L-384 card](https://huggingface.co/BVRA/MegaDescriptor-L-384)). Licence: `cc-by-nc-4.0` (card). The surrounding toolkit is **AGPL-3.0** with a commercial licence on request ([wildlife-datasets](https://github.com/WildlifeDatasets/wildlife-datasets)), while `wildlife-tools` is MIT (GitHub API). The weights work through `timm`, so the toolkit is not needed. CatIndividualImages and DogFaceNet were added to the toolkit on 2024-05-09 (same README). Whether the 2024-10-14 L-384 revision was retrained on them is **[unverified]**.
- **MiewID-msv3** (Conservation X Labs / Wild Me). EfficientNetV2 with sub-center ArcFace. Its dog mAP is 70.9 and rank-1 78.7 on its own split ([card](https://huggingface.co/conservationxlabs/miewid-msv3)). The paper reports that a multispecies model beats MegaDescriptor on 33 unseen species by an average 19.2 % top-1 ([arXiv 2412.05602](https://arxiv.org/abs/2412.05602)). **No licence is declared** on the HF card, the GitHub repo (`license: null`) or `setup.py`, so by default no use is granted. Do not use it until Wild Me states a licence.
- **Older dog and cat work:** DogFaceNet (PRICAI 2019, TF 1.12, MIT; its dataset is now on [Zenodo](https://zenodo.org/records/12578449)) is superseded by the above ([repo](https://github.com/GuillaumeMougeot/DogFaceNet)). A 2025 feral-cat re-ID paper adapts a tiger network to camera-trap images ([arXiv 2507.11575](https://arxiv.org/pdf/2507.11575)). It was not read beyond a search summary **[unverified]**, and camera traps are not family photos.
- **Newer than 2025:** searches found no DINOv3-based pet re-ID result and no 2026 pet-specific model with ONNX weights. A 2025 AnimalCLEF paper reportedly found a projection head helped MegaDescriptor far more than DINOv2 ([arXiv 2509.12353](https://arxiv.org/abs/2509.12353)) **[unverified: search summary only]**.

### 3.4 Detectors (Q2)
- **COCO's 80 classes already include `cat`, `dog`, `bird`, `horse`, `sheep` and `cow`** ([COCO](https://cocodataset.org/#explore)) **[category list not re-read for this note]**. So any COCO detector finds the common pets as whole-body boxes. Hamsters, rabbits, tortoises and similar pets are not COCO classes. They need an open-vocabulary detector or Objects365 weights.
- **D-FINE** (Apache-2.0, active). It has the best AP per parameter among the permissive candidates, and its ONNX output already contains `labels/boxes/scores` ([export_onnx.py](https://github.com/Peterande/D-FINE/blob/master/tools/deployment/export_onnx.py), [onnx_inf.py](https://github.com/Peterande/D-FINE/blob/master/tools/inference/onnx_inf.py)). Only GPU latency is published. DEIM, built on D-FINE, is also Apache-2.0 ([LICENSE](https://github.com/ShihuaHuang95/DEIM/blob/master/LICENSE)). **DEIMv2 uses its own "DEIMv2 License"** with commercial enquiries by email ([README](https://github.com/Intellindust-AI-Lab/DEIMv2)), so skip it.
- **NanoDet-Plus / YOLOX** (Apache-2.0). These are the only permissive detectors with *CPU* latency from their owners or OpenCV Zoo (table 2.1). They are older (2021–2022) and less accurate, but their CPU behaviour is known.
- **RF-DETR**: N–L are Apache-2.0. The smallest (A/F/P) and largest (XL/2XL) need `rfdetr_plus` under "PML 1.0" ([README](https://github.com/roboflow/rf-detr)). At about 30M params, even Nano is heavier than D-FINE-S.
- **MegaDetector V6** finds `animal / person / vehicle` in camera-trap images and is "not a species classifier" ([docs](https://microsoft.github.io/MegaDetector/)). It would not tell a dog from a squirrel at the bottom of a garden photo. Two V6 variants are permissive (Apache RT-DETR, MIT YOLOv9). The rest are AGPL-3.0 ([model zoo](https://microsoft.github.io/MegaDetector/model_zoo/)). No ONNX is mentioned. Not a fit.
- **Ultralytics YOLO (v8/11/26), YOLOv10 and YOLO-World are AGPL-3.0, AGPL-3.0 and GPL-3.0** (GitHub API; [Ultralytics docs](https://docs.ultralytics.com/models/yolo11/)). YOLOv9's original repo is GPL-3.0. Only the `MultimediaTechLab/YOLO` re-implementation is MIT (GitHub API). LibrePhotos explicitly excludes Ultralytics for this reason ([librephotos#548](https://github.com/LibrePhotos/librephotos/issues/548)).
- **OWLv2 / Grounding DINO** (Apache-2.0). Their open vocabulary ("a tortoise") is the only route to non-COCO pets. Their community ONNX exports run from 155–720 MB, and no CPU latency is published. They are overkill for cats and dogs.
- **Pet-face detectors** (dlib dog hipsterizer, AnyFace, OpenCV's cat Haar cascade) only matter if the embedding needs aligned *faces*, as PetFace does. The recommended embeddings work on body crops, so none is needed.

---

## 4. What comparable apps do (Q4)

| App | Individual pet recognition? | Evidence |
|---|---|---|
| **Immich** | **No.** Feature request open since 2024-02 with 801 upvotes. Maintainers: "getting a pet recognition (not detection) model in the first place is more involved" (2024-10). "This isn't happening anytime soon" (2025-07). A community PR adding `PetDetector`/`PetRecognizer`, a `personType` (Human/Pet) column and Hugging Face models (MegaDescriptor or CLIP) was auto-closed on 2026-05-08 as LLM-generated. Workaround offered: CLIP smart search | [discussion #7151](https://github.com/immich-app/immich/discussions/7151), [PR #28297](https://github.com/immich-app/immich/pull/28297); code search for "pet" under `machine-learning/` returns nothing |
| **PhotoPrism** | **No.** Issue "AI: Animal pet detection" open since 2021 (labels `idea`, `help wanted`). Species labels (cat, dog…) come from the classifier | [issue #1561](https://github.com/photoprism/photoprism/issues/1561), [classify/labels.txt](https://github.com/photoprism/photoprism/blob/develop/internal/ai/classify/labels.txt); no pet code in `internal/ai/face` |
| **LibrePhotos** | **No.** Issue open since 2022. On 2026-10-22 the maintainer wrote: species search already works through scene tags and semantic search. The proposed next step is a spike with a COCO detector (YOLOX or RT-DETR) + OpenCLIP or DINOv2 + the existing HDBSCAN; "If it does, pets can reuse `Person` with a new kind." Requires "ONNX, MIT or Apache licensed, so not Ultralytics YOLO" | [issue #548](https://github.com/LibrePhotos/librephotos/issues/548) |
| **digiKam** | **No.** Auto-tags use EfficientNet-B7 or YOLOv11 (COCO, 80 classes) for object tags only. No pet-recognition request found in KDE Bugzilla summary searches | [autotags docs](https://docs.digikam.org/en/maintenance_tools/maintenance_autotags.html), [bugs.kde.org](https://bugs.kde.org/) (REST search, 2026-10-26) |
| **Synology Photos** | **No individual pets.** Face recognition → People albums. Object recognition → "Subjects" albums. Pets are not mentioned | [DSM 7.4 spec](https://www.synology.com/en-global/dsm/7.4/software_spec/synology_photos) |
| Apple Photos (reference) | **Yes**, since iOS 17: the People album recognises "people, as well as cats and dogs" with on-device ML | [Apple Newsroom, 2023-06](https://www.apple.com/newsroom/2023/06/ios-17-makes-iphone-more-personal-and-intuitive/) |
| Google Photos (reference) | **Yes**: label "people or pets" in face groups. A separate "Show pets with people" toggle | [Google Photos help](https://support.google.com/photos/answer/6128838) |

The pattern: none of the self-hosted apps ships it. All of them give species search through tags or CLIP. Every one that has scoped the feature (the Immich PR, the LibrePhotos plan) uses a *separate* detector and embedding next to the face pipeline, and stores pets as people with a "kind".

---

## 5. Practical fit (Q5)

**Sizes added to the image** (today: `det_500m.onnx` + `w600k_mbf.onnx` ≈ 16 MB):

| Pipeline | Detector | Embedding | Approx. total |
|---|---|---|---|
| Light (spike) | D-FINE-S 41.5 MB fp32 / 11.2 MB int8³, or NanoDet 3.8 MB | DINOv2-S 88.5 MB fp32 / 24.4 MB int8³ | ~30–130 MB |
| Recommended | D-FINE-S | AvitoTech CLIP-L, vision tower only; safetensors 1.71 GB includes the text tower, and the vision-only ONNX size is **[unverified]** | ~1–1.8 GB |
| Non-commercial alternative | D-FINE-S | MegaDescriptor-L-384, 1.94 GB `.bin`; T-224 is 204 MB | ~0.25–2 GB |

**CPU cost per Photo.** The detector runs on every Photo. The embedding runs once per detected animal, so Photos without pets pay only for detection. Published CPU figures exist only for the detectors: NanoDet 11.5 ms (i7-8700, OpenVINO) or 41 ms (12700K, OpenCV DNN), and YOLOX-S 79 ms (12700K) (table 2.1). MegaDetector's YOLOv10-c is quoted at 2–5 images/s on a "modern CPU" ([docs](https://microsoft.github.io/MegaDetector/)). **No source publishes CPU latency for D-FINE, DINOv2-S, CLIP-L or MegaDescriptor.** Measure them under `onnxruntime-node` on the home server.

**Slotting in next to `src/server/faces/`:**
1. Reuse the decoded `Pixels`. Letterbox to 640 for D-FINE and pass `orig_target_sizes`, so the returned boxes are already in Photo coordinates ([onnx_inf.py](https://github.com/Peterande/D-FINE/blob/master/tools/inference/onnx_inf.py)). Keep `cat`/`dog` above a score threshold.
2. Crop each box (square-pad), resize to 224, normalise per the model (CLIP mean/std for the Avito model; ImageNet mean/std for DINOv2), embed, then L2-normalise.
3. Compare by cosine, using the same Suggestion/Stranger machinery as Faces but in a **separate embedding space with its own thresholds**. Thresholds do not transfer between models (earlier note §5).
4. No landmark alignment is needed for body crops, so there is no equivalent of `align.ts`.
5. Add the new files to `scripts/fetch-models.sh` and `models.sha256`, pinned to an HF commit and SHA-256, the way the buffalo files are.
- Neither the Avito model nor MegaDescriptor ships ONNX. Export once offline (e.g. `optimum` / `torch.onnx`) and pin the result **[unverified that they export cleanly]**.
- **Licence summary for the recommended set:** D-FINE (Apache-2.0, COCO checkpoints) + Avito CLIP-L (Apache-2.0) or DINOv2 (Apache-2.0). Unlike `buffalo_sc`, these *could* ship in a published image, subject to the PetFace training-data caveat (§6).

---

## 6. Licence caveats

| Item | What the owner says | Where |
|---|---|---|
| PetFace dataset / code / models | "for non-commercial research purpose only". "This dataset is for research purposes only." No LICENSE file | [repo](https://github.com/mapooon/PetFace), [project page](https://dahlian00.github.io/PetFacePage/) |
| AvitoTech CLIP-L | `apache-2.0` on the card, **but** trained partly on PetFace. Whether research-only data terms reach a derived model is not settled by either party (the same question as WebFace260M in the earlier note) | [card](https://huggingface.co/AvitoTech/Zer0int-CLIP-L-for-animal-identification) |
| MegaDescriptor weights | `cc-by-nc-4.0`. CC BY-NC permits non-commercial use with attribution. That is arguably a *clearer* fit for a private family viewer than InsightFace's "non-commercial research only" | [card](https://huggingface.co/BVRA/MegaDescriptor-L-384) |
| WildlifeDatasets toolkit | AGPL-3.0, "covers the code in this repository only". Commercial licence available | [README](https://github.com/WildlifeDatasets/wildlife-datasets) |
| MiewID-msv3 | No licence stated anywhere checked | [card](https://huggingface.co/conservationxlabs/miewid-msv3), [repo](https://github.com/WildMeOrg/wbia-plugin-miew-id) |
| DINOv2 / DINOv3 | Apache-2.0 / custom DINOv3 License (redistribution must carry the licence and "Built with DINOv3"; termination on breach) | GitHub API, [DINOv3 License](https://ai.meta.com/resources/models-and-libraries/dinov3-license/) |
| D-FINE | Apache-2.0. Objects365-trained checkpoints "should not be assumed to be commercially cleared" | [README](https://github.com/Peterande/D-FINE) |
| RF-DETR | Apache-2.0 for N–L detection. A/F/P/XL/2XL under "PML 1.0" | [README](https://github.com/roboflow/rf-detr) |
| Ultralytics YOLO, YOLOv10, YOLO-World, YOLOv9 (orig.) | AGPL-3.0 / AGPL-3.0 / GPL-3.0 / GPL-3.0 | GitHub API |
| MegaDetector V6 | Per-variant: Apache-2.0 (`apa-rtdetr`), MIT (`mit-yolov9`), others AGPL-3.0 | [model zoo](https://microsoft.github.io/MegaDetector/model_zoo/) |
| AnyFace | MIT LICENSE, derived from GPL-3.0 `yolov5-face` | GitHub API |

---

## 7. How pets fit the domain model and ADRs

**Glossary (`GLOSSARY.md`, "People in the photo").** Every current term is about people:
- **Face** = "A region of a Photo that shows one person's face." The pet detector boxes the *whole animal*, not its face, so this needs a new term for "a region of a Photo that shows one animal" (candidates: *Animal*, *Pet sighting*). Stretching Face would make it mean something else.
- **Person** = "Someone the user has named". A named pet needs its own term (candidate: *Pet*). Note that the glossary's _Avoid_ list for Person includes "Subject" and "identity", which are the words Immich's PR and PhotoPrism use for an umbrella term. If an umbrella term for "Person or Pet" is wanted, choose it on purpose.
- **Suggestion** = "A Person the viewer thinks a Face shows". This would widen to cover a Pet for an animal region, or get a pet counterpart.
- **Stranger** = "A set of unnamed Faces … shown as 'Unknown 4'". Unnamed groups of animal regions need an equivalent label (e.g. "Unknown pet 2"). "Stranger" reads oddly for a dog.
- **Overlap rule:** a Face found inside a dog's box is probably a false Face (§3.1). Decide whether the viewer suppresses it, flags it, or leaves it to "Not a face".
- Use the `domain-modeling` skill to settle these before code.

**ADR-0001.** Its Consequences say "The one exception to retaining nothing is face data". Pet embeddings, boxes and names are new retained data, so this line changes whichever way ADR-0002 goes.

**ADR-0002.** It is scoped to "each Face's embedding … along with the name of each Person", justified as "biometric data about our children". Pet data is not biometric data about people, so the risk argument differs. Three things still need an explicit decision:
1. **Scope:** amend ADR-0002 to "face and pet data", or write ADR-0003 for pet embeddings alone. The latter keeps the children's-biometrics reasoning undiluted.
2. **Crops can contain children.** A whole-animal box often includes a child hugging the dog, so the pet embedding is computed from pixels that include a child's face. It is not a face embedding, but it is derived from one. The new ADR should state whether this gets face-data protection (same separate store, same "never leaves the server", same one-step wipe, kept out of off-server backups).
3. **Model swaps:** ADR-0002's "changing the face model means recomputing every embedding" applies separately to the pet model. The licence consequence (non-commercial weights must not ship in a published image) applies only if MegaDescriptor or PetFace weights are chosen.

---

## 8. Trial run on our own pets

**Run:** 2026-10-26, with `pixi run pet-trial pets` (`scripts/pet-trial/similarity.ts`). The sample is 20 family Photos of five pets (Baron 6, Calypso 4, Nellie 4, Oden 3, Zepher 3), so there are 33 same-pet pairs and 157 different-pet pairs. These are the first measured numbers in this note; everything above is from published sources.

**Pipeline as run:**
- **Detector:** D-FINE-S (COCO), from [onnx-community/dfine_s_coco-ONNX](https://huggingface.co/onnx-community/dfine_s_coco-ONNX) at revision `a3cf031`. The Photo is stretched to 640×640, and a cat or dog counts above sigmoid score 0.5. The largest one in each Photo is taken to be the pet.
- **Crop:** the box is padded square with black and resized to 224.
- **DINOv2-S:** fp32, from [onnx-community/dinov2-small-ONNX](https://huggingface.co/onnx-community/dinov2-small-ONNX) at `08c606e`. The class token is used, with ImageNet mean/std.
- **Avito CLIP-L:** the vision tower plus projection, exported locally from revision `f50a193` by `scripts/pet-trial/export-avito.py`, with CLIP mean/std.
- **Similarity:** both embeddings are L2-normalised and compared by cosine.

**Detection:** D-FINE-S found a pet in all 20 Photos: 13 dogs and 7 cats.

| | DINOv2-S | Avito CLIP-L |
|---|---|---|
| Nearest neighbour is the same pet | 19/20 (95 %) | **20/20 (100 %)** |
| Same-pet cosine, min / median / max | 0.377 / 0.603 / 0.985 | 0.429 / **0.810** / 0.991 |
| Different-pet cosine, min / median / max | −0.017 / 0.154 / 0.592 | 0.045 / 0.250 / 0.637 |
| Lowest cut-off with 0 % different-pet pairs | 0.60 → 51.5 % of same-pet pairs | 0.65 → **93.9 %** of same-pet pairs |
| Same-pet pairs kept at a cut-off with ≤ 2 % different-pet pairs | 60.6 % at 0.55 (0.6 % different) | 97.0 % at 0.60 (1.9 % different) |

DINOv2-S's one miss matched Nellie to a Photo of Baron at cosine 0.447.

**CPU time** is the median under `onnxruntime-node` 1.30 (CPU provider, fp32) on the development machine (16 cores), not on the home server:

| Step | Time |
|---|---|
| Decode | 192 ms per Photo |
| D-FINE-S | 159 ms per Photo |
| DINOv2-S | 248 ms per pet |
| Avito CLIP-L | 740 ms per pet |

A 4-Photo smoke test on the same machine measured D-FINE-S at 187–277 ms, so expect run-to-run noise of that size.

**ONNX export:** the Avito vision tower exported cleanly with the TorchScript exporter (opset 17). It is **1,216 MB in fp32**, and its output matches PyTorch within 1e-3 on a random input. No int8 version was made.

**Reading:**
- Avito CLIP-L separates our pets clearly better than DINOv2-S. Its same-pet pairs sit higher (median 0.81 against 0.60) while different-pet pairs rise only a little. So a single cut-off near 0.65 accepts almost every true match and no false one, where DINOv2-S has to give up half its true matches to stay clean.
- This agrees with the published direction (§2.3): pet-trained beats general.
- **Caveats:** 33 same-pet pairs cannot set a production threshold. Avito's highest different-pet pair (0.637) and its clean cut-off (0.65) are close together. The sample has no lookalike pair, which is the hard case PhotoPrism's maintainer names (two black cats). Collecting 20 or more Photos per pet, including lookalikes, would make a threshold trustworthy.

---

## 9. Open questions

1. ~~**Spike on our own pets**~~ **Partly answered (§8):** on 20 Photos, Avito CLIP-L clearly beats DINOv2-S, so build on Avito CLIP-L. Still open: a larger sample (20+ Photos per pet, including lookalikes) to set the Suggestion and Stranger thresholds.
2. **CPU latency on the home server.** It is measured on the development machine only (§8): D-FINE-S ~160 ms per Photo, DINOv2-S ~250 ms and Avito CLIP-L ~740 ms per pet. Rerun `pixi run pet-trial` on the server itself.
3. **Avito CLIP-L ONNX export:** ~~does it export cleanly?~~ Yes, 1,216 MB in fp32 (§8). Still open: would an int8 version keep the separation at about a quarter of the size?
4. **PetFace terms vs derived weights:** does "research purposes only" on the PetFace data bind Avito's Apache-2.0 model? Only PetFace's authors or Avito can answer.
5. **MiewID licence:** ask Wild Me / Conservation X Labs. It is the strongest frozen model on dogs in the 2026 comparison.
6. **Non-COCO pets** (rabbits, tortoises, hamsters): do we need them? If so, OWLv2 or an Objects365 detector is needed, at roughly 10× the size.
7. **Does SCRFD-500MF fire on our pets' faces?** If it often does, handle the Face-inside-pet-box overlap (§7) in the first version.
8. ~~**Domain terms and ADR**~~ **Settled:** `GLOSSARY.md` adds Animal, Pet and Unknown pet and widens Suggestion. ADR-0003 keeps pet data under the same protection as face data.
