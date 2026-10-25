# Face recognition on CPU: which model to use

**Question:** What is the best face recognition model that runs on a CPU, for a self-hosted family photo viewer (Node.js/TypeScript backend, home server, Docker, no cloud)?
**Researched:** 2026-10-24. Sources are primary (repos, model cards, papers, licence files) unless marked **[unverified]** or **[secondary]**. No benchmarks were run for this note; every number comes from the source it is credited to.

---

## 1. Recommendation

**Best overall: InsightFace `buffalo_l`, run through `onnxruntime-node`.** It pairs the SCRFD-10GF detector with an ArcFace ResNet-50 trained on WebFace600K. It is the most accurate pack that still runs comfortably on a CPU: LFW 99.83, CFP-FP 99.33, AgeDB-30 98.23 and IJB-C(E4) 97.25 ([model_zoo.md](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#recognition-accuracy)). Immich ships it as the default ([config.dto.ts](https://github.com/immich-app/immich/blob/main/server/src/dtos/config.dto.ts)), and LibrePhotos supports it ([main.py](https://github.com/LibrePhotos/librephotos/blob/dev/apps/backend/service/face_recognition/main.py)), so the pipeline is proven on family libraries. **Licence caveat:** InsightFace says the weights are *"for non-commercial research only"* ([python-package README](https://github.com/deepinsight/insightface/blob/master/python-package/README.md#license)). A private family viewer is non-commercial, but it is not plainly "research" (see §6). If the server is short on power, `buffalo_s` is the same pipeline at about 16 MB (SCRFD-500MF + MobileFaceNet), at AgeDB-30 96.58 and IJB-C 95.02, under the same licence.

**Fully permissive alternative: YuNet (MIT) for detection + AuraFace v1 (Apache-2.0) for recognition.** Use only AuraFace's `glintr100.onnx`; the other files in that repo are InsightFace weights (§6). AuraFace scores LFW 99.65, CFP-FP 95.19, AgeDB 96.10, CALFW 94.70 ([model card](https://huggingface.co/fal/AuraFace-v1)). It is a ResNet-100 (261 MB), so it is heavier on CPU than `buffalo_l` while being less accurate. A lighter permissive choice is **YuNet + SFace (Apache-2.0, 39 MB, LFW 99.40)**. That is what digiKam uses, and it is PhotoPrism's default on its development branch (§7).

**ADR-0001 conflict, flagged:** detecting faces in a single Photo during a request fits ADR-0001. **Recognising people across Photos does not.** It means keeping face embeddings (biometric data derived from children's faces) after the response, and ADR-0001 promises nothing is retained. Clustering or naming people needs a new ADR first. Separately, model weights must be baked into the image at build time and never fetched at runtime (§8).

---

## 2. Comparison table

All accuracy figures are verification accuracy (%) or TAR (%) at the stated FAR, as published by each source. Different sources use different evaluation code, so compare across rows with care.

### Recognition (embedding) models

| Model (weights) | Arch / params / FLOPs | ONNX size | LFW | CFP-FP | AgeDB-30 | IJB-C TAR@1e-4 | Training data | Weights licence | Last activity |
|---|---|---|---|---|---|---|---|---|---|
| **InsightFace buffalo_l** (`w600k_r50`) | ResNet-50, ~6.3 GFLOPs¹ | 174 MB² | 99.83 | 99.33 | 98.23 | 97.25 | WebFace600K | Non-commercial research | v2.1, 2026-10-03 |
| InsightFace buffalo_s / buffalo_sc (`w600k_mbf`) | MobileFaceNet, ~0.45 GFLOPs¹ | 14 MB² | 99.70 | 98.00 | 96.58 | 95.02 | WebFace600K | Non-commercial research | same |
| InsightFace antelopev2 (`glintr100`) | ResNet-100, ~12.1 GFLOPs¹ | 261 MB² | — | — | — | (r100@Glint360K: 97.55¹) | Glint360K | Non-commercial research | same |
| **AuraFace v1** (`glintr100.onnx`) | ResNet-100 ArcFace | 261 MB | 99.65 | 95.19 | 96.10 | not published | "commercial dataset", undisclosed | Apache-2.0 | 2024-08-26 |
| **SFace** (OpenCV Zoo, `2021dec`) | MobileFaceNet + SFace loss | 39 MB | 99.40 | — | — | — | not stated by OpenCV Zoo | Apache-2.0 | repo active 2026-10 |
| EdgeFace (xs γ0.6 / s γ0.5 / base) | 1.77M / 3.65M / 18.2M params; 154 / 306 / 1399 MFLOPs | PyTorch only | 99.73 / 99.78 / 99.83 | 94.71 / 95.74 / 97.01 | 96.08 / 97.03 / 97.60 | xs: 94.85 (abstract) | WebFace4M/12M | BSD-3-Clause code+weights; data research-only | 2025-08 |
| AdaFace R50 / R18 | ResNet | PyTorch only | 99.78 / 99.53 | 98.97 / 97.26 | 97.78 / 96.47 | 96.98 / 94.99 | WebFace4M | MIT code; data research-only | 2024-07 |
| LVFace-T / -S / -B (ICCV 2025) | ViT | ONNX + .pt | — | — | — | 96.67 / 97.31 / 97.70 | Glint360K | Non-commercial research | 2025-08 |
| FaceLiVTv2-S (2026) | 4.62M params, 179M MAdds | PyTorch | see paper | | | 95.99 **[secondary/unverified]** | Glint360K | BSD-3 text in repo (copied from EdgeFace) | 2026-04 |
| GhostFaceNetV1-1.3-1 | GhostNet | Keras .h5 | 99.73 | 96.83 | 98.00 | 94.94 | MS1MV3 | MIT code | 2024-01 |
| dlib ResNet v1 | 29-layer ResNet | dlib .dat (no ONNX) | 99.38 | — | — | — | ~3M faces (VGG, FaceScrub, scraped) | Public domain (CC0) | dlib 20.0.1, 2026-03 |
| FaceNet (VGGFace2) | Inception-ResNet-v1 | TF / PyTorch | 99.65 | — | — | — | VGGFace2 | MIT code | 2025-09 (facenet-pytorch) |

¹ Taken from the matching backbone row of the [arcface_torch tables](https://github.com/deepinsight/insightface/blob/master/recognition/arcface_torch/README.md). These were not measured on the exact pack weights.
² ONNX sizes from Immich's Hugging Face mirrors ([buffalo_l](https://huggingface.co/immich-app/buffalo_l), [buffalo_s](https://huggingface.co/api/models/immich-app/buffalo_s/tree/main/recognition), [antelopev2](https://huggingface.co/api/models/immich-app/antelopev2/tree/main/recognition)).

### Detection models

| Detector | Params / FLOPs | ONNX size | WIDER Face AP (Easy / Medium / Hard) | 5 landmarks | Weights licence |
|---|---|---|---|---|---|
| SCRFD-10GF (`det_10g`, in buffalo_l) | 3.86M / 10 GFLOPs @VGA | 16.9 MB | 95.16 / 93.87 / 83.05 | yes (`_KPS`) | Non-commercial research (InsightFace) |
| SCRFD-500MF (`det_500m`, in buffalo_s) | 0.57M / 0.5 GFLOPs @VGA | 2.5 MB | 90.57 / 88.12 / 68.51 | yes | Non-commercial research |
| YuNet (`2023mar` / `2026may`) | tiny | 0.23 MB | 88.44 / 86.56 / 75.03 | yes | MIT |
| RetinaFace-MobileNet0.25 | 0.44M / 0.8 GFLOPs | — | 87.78 / 81.16 / 47.32 | yes | (reported in the SCRFD README) |

SCRFD figures come from the [SCRFD README](https://github.com/deepinsight/insightface/blob/master/detection/scrfd/README.md), YuNet figures from the [OpenCV Zoo YuNet README](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet). The two use different evaluation tooling.

---

## 3. Per-model notes

### InsightFace packs (buffalo_l / buffalo_m / buffalo_s / buffalo_sc / antelopev2)
- Pack contents from [model_zoo.md](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#legacy-model-packs): `buffalo_l` = SCRFD-10GF + ResNet50@WebFace600K, 326 MB with the 2d106/3d68 landmark and gender/age models. `buffalo_s` = SCRFD-500MF + MBF@WebFace600K, 159 MB. `buffalo_sc` = the same two models with nothing else, 16 MB. `antelopev2` = SCRFD-10GF + ResNet100@Glint360K, 407 MB. For recognition you need only the detector and the recognizer: about 191 MB for `buffalo_l` and about 16 MB for `buffalo_s`.
- Fairness across ethnic groups, from the same table (MR-ALL / African / Caucasian / South Asian / East Asian): `buffalo_l` 91.25 / 90.29 / 94.70 / 93.16 / **74.96**; `buffalo_s` 71.87 / 69.45 / 80.45 / 73.39 / **51.03**. Both are noticeably weaker on East Asian faces.
- "`buffalo_m` has the same recognition accuracy as `buffalo_l`. `buffalo_sc` has the same recognition accuracy as `buffalo_s`" ([model_zoo.md](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#recognition-accuracy)).
- Larger arcface_torch backbones trained on WebFace42M exist (r100 IJB-C 97.82, ViT-B 97.90, ViT-L 98.00), but none of them ships in a pack ([arcface_torch README](https://github.com/deepinsight/insightface/blob/master/recognition/arcface_torch/README.md)).
- **CPU latency:** InsightFace publishes none for the packs. The only CPU figure is for SCRFD-0.5GF: 28.3 ms at 640×480, single thread, PyTorch, Ryzen 9 3950X ([SCRFD README](https://github.com/deepinsight/insightface/blob/master/detection/scrfd/README.md)). The "Infer(ms)" column in the SCRFD tables does not name its hardware **[unverified whether CPU or GPU; likely GPU]**.
- Maintenance: very active. InsightFace 1.0 came out on 2026-05-23, 2.0 on 2026-09-09 and 2.1 on 2026-10-03 (PyPI, [README news](https://github.com/deepinsight/insightface/blob/master/README.md)). The new `raccoon_*` and `cheetah_*` packs (2.x) target PrivateFrame and person ReID. Cheetah's face detection and recognition ONNX files "are identical to those in `buffalo_s` … and `buffalo_l`" ([model_zoo.md](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#cheetah-person-analysis-packages)), so there is no new face-recognition model.

### AuraFace v1 (fal)
- ResNet-100 ArcFace "trained on commercially and publicly available data sources to enable its usage in commercial setting". The card adds that the training set "may not extensively cover all ethnicities" ([model card](https://huggingface.co/fal/AuraFace-v1)). Training data is not disclosed, and no IJB-B/C numbers are given.
- Card licence `apache-2.0`, and the repo's [LICENSE.md](https://huggingface.co/fal/AuraFace-v1/blob/main/LICENSE.md) is the Apache 2.0 text. Last change was 2024-08-26 (HF API).
- PhotoPrism ran an independent benchmark on an unnamed labelled dataset. At 0.14 % FAR: AuraFace TAR 0.9308, `arcface_mbf` (InsightFace MBF) 0.9648, `arcface_r50` 0.9943 ([PhotoPrism face README](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/README.md), "Model-Specific Thresholds"). On that benchmark AuraFace is **below the 14 MB buffalo_s recognizer** even though it is about 19× bigger.

### SFace (OpenCV Zoo)
- "Model files encode MobileFaceNet instances trained on the SFace loss function". Accuracy 0.9940, 0.9942 block-quantized, 0.9932 int8 ([README](https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface)). This is LFW, evaluated with YuNet as the detector ([tools/eval](https://github.com/opencv/opencv_zoo/blob/main/tools/eval/README.md#lfw)).
- Licence: Apache 2.0 ([LICENSE](https://github.com/opencv/opencv_zoo/blob/main/models/face_recognition_sface/LICENSE)).
- Training data **not stated** for the zoo weights. The SFace paper trained models on CASIA-WebFace, VGGFace2 and MS-Celeb-1M ([SFace repo](https://github.com/zhongyy/SFace)).
- CPU latency, published: **5.09 ms** mean per face on an Intel i7-12700K, and 68.8 ms on a Raspberry Pi 4B (OpenCV DNN CPU backend; [benchmark README](https://github.com/opencv/opencv_zoo/blob/main/benchmark/README.md)).
- Embedding is 128-d (PhotoPrism [models.go](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/models.go)).

### YuNet (OpenCV Zoo)
- WIDER Face val AP 0.8844 / 0.8656 / 0.7503. It "can detect **faces of pixels between around 10x10 to 300x300**" ([README](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet)), so large photos must be downscaled first, and a very close-up portrait may need a smaller input.
- `face_detection_yunet_2026may.onnx` (added 2026-05-22) has dynamic H/W, so it suits ONNX Runtime directly. Licence MIT ([LICENSE](https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE)).
- CPU latency: 0.69 ms at 160×120 on a 12700K, 6.2 ms on a Pi 4B ([benchmark README](https://github.com/opencv/opencv_zoo/blob/main/benchmark/README.md)).
- PhotoPrism warns that YuNet and SCRFD are not rotation invariant: "recall falls away past roughly +/-30 degrees of in-plane roll" ([PhotoPrism face README](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/README.md)). That matters for photos of children lying down.

### EdgeFace (Idiap)
- Won the compact track of EFaR 2023. The table above is taken from the [repo README](https://github.com/otroshi/edgeface). The abstract reports LFW 99.73, IJB-B 92.67 and IJB-C 94.85 for the 1.77M-param model ([arXiv 2307.01838](https://arxiv.org/abs/2307.01838)).
- Trained on "the WebFace 12M and WebFace 4M subsets" of WebFace260M (paper, §Experiments).
- [LICENSE](https://github.com/otroshi/edgeface/blob/main/LICENSE) is BSD-3-Clause (© Idiap) with no extra clause. The WebFace260M data, however, is meant to be "for research purposes only" (see §6).
- Weights are PyTorch only (torch.hub). There is **no official ONNX**, so you would export it yourself **[unverified that it exports cleanly]**.

### AdaFace
- Accuracy table and MIT code licence from the [repo](https://github.com/mk-minchul/AdaFace), last pushed 2024-07. No model-specific licence is stated. Training sets are WebFace4M/12M, MS1MV2/V3, VGGFace2 and CASIA, so the dataset terms govern. There is no official ONNX.

### Newer releases, 2024–2026
- **LVFace** (ByteDance, ICCV 2025): ViT-based, with ONNX weights. IJB-C@1e-4 is 96.67 (T) to 97.70 (B). Licence: "The models downloaded from our repo follow the above license policy (which is for non-commercial research purposes only)" ([README](https://github.com/bytedance/LVFace#license)). The README *also* shows an MIT badge, so its own statements disagree. ViT-B and above are heavy for a CPU.
- **FaceLiVT / FaceLiVTv2** (ICIP 2025; arXiv 2604.09127, 2026): hybrid CNN-Transformer for mobile. v2-S has 4.62M params and 179M MAdds ([repo](https://github.com/novendrastywn/FaceLiVT)). A search-engine summary credited IJB-B 94.51 / IJB-C 95.99 to a 4.62M-param variant, but those figures are not in the arXiv abstract ([arXiv 2604.09127](https://arxiv.org/abs/2604.09127)) and were not checked against the paper body **[unverified]**. It is trained on Glint360K. The repo LICENSE is a BSD-3 text naming the EdgeFace authors, which looks copied **[licence intent unclear]**. No ONNX is provided, and the weights' location was not confirmed.
- **GhostFaceNets** (2023, MIT code, Keras weights on MS1MV2/V3; [repo](https://github.com/HamadYA/GhostFaceNets)): no newer releases since 2024-01.
- No 2024–2026 model was found that beats `buffalo_l` on IJB-C at a CPU-friendly cost and also ships ONNX under a permissive licence.

### dlib ResNet v1
- LFW 0.993833. The README calls it "mean error", which is evidently a typo for accuracy. It is a 29-conv-layer ResNet trained on about 3M faces with 7485 identities. Davis King: "I've released them into the public domain" ([dlib-models README](https://github.com/davisking/dlib-models), [LICENSE CC0](https://github.com/davisking/dlib-models/blob/master/LICENSE)).
- Caution: `shape_predictor_68_face_landmarks` is trained on iBUG 300-W, and "the trained model therefore can't be used in a commercial product" (same README). Use the 5-point predictor instead.
- Using it from Node needs native dlib bindings. There is no ONNX. It is also the oldest and least accurate option here. Immich, LibrePhotos and digiKam all moved away from it: LibrePhotos has a migration that clears the old 128-d encodings ([0126 migration](https://github.com/LibrePhotos/librephotos/blob/dev/apps/backend/api/migrations/0126_clear_128dim_face_encodings.py)), and the old digiKam GitHub mirror still contains `dlib_face_recognition_resnet_model_v1.dat`.

### FaceNet, MagFace
- FaceNet (Inception-ResNet-v1, VGGFace2): LFW 0.99650 ([davidsandberg/facenet](https://github.com/davidsandberg/facenet), [facenet-pytorch](https://github.com/timesler/facenet-pytorch)). PhotoPrism lists its weight licence as "unknown" and is moving off it.
- MagFace: Apache-2.0 code, iResNet weights trained on MS1MV2 ([repo](https://github.com/IrvingMeng/MagFace)), last pushed 2023-12. Its quality-aware magnitude is interesting for filtering blurry faces, but it is not CPU-oriented.

### Children and cross-age
- None of the standard benchmarks covers children. AgeDB-30 and CALFW are cross-age sets of adults.
- YLFW (Young LFW) was built for this purpose. Its authors conclude their experiments "demonstrate the imperfectness of modern deep face recognition approaches to children's faces", and that COTS and academic systems "are biased to recognize adults better than children" ([arXiv 2301.05776](https://arxiv.org/abs/2301.05776)). They benchmarked ArcFace, AdaFace and MagFace R50s on MS1MV2. None of the CPU candidates above publishes YLFW results.
- Both Immich and LibrePhotos work around this with **birth dates**. Immich's matcher passes `minBirthDate: face.asset.fileCreatedAt` ([person.service.ts](https://github.com/immich-app/immich/blob/main/server/src/services/person.service.ts)). LibrePhotos' face suggestions "leave out the people born after a photo was taken" ([birth_dates.py](https://github.com/LibrePhotos/librephotos/blob/dev/apps/backend/api/faces/birth_dates.py)). Expect one child to split into several age clusters that a person merges by hand; PhotoPrism states that "A subject may own several clusters by design" ([face README](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/README.md)).

---

## 4. Alignment

Every ArcFace-family model (buffalo_*, AuraFace, SFace, EdgeFace, AdaFace) expects a **112×112 crop**. The crop is warped by a similarity transform that maps the detector's 5 landmarks onto the canonical ArcFace template `[[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]]` ([Immich `_ops.py`](https://github.com/immich-app/immich/blob/main/machine-learning/immich_ml/models/facial_recognition/_ops.py), a port of InsightFace's `norm_crop`). The transform is the Umeyama estimate followed by `cv2.warpAffine`. PhotoPrism ([align.go](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/align.go)) and LibrePhotos ([face_analysis.py](https://github.com/LibrePhotos/librephotos/blob/dev/apps/backend/service/face_recognition/face_analysis.py)) each re-implement it, because embeddings are only comparable when the crop is the same. In TypeScript this is about 50 lines: a 2×2 similarity solve over the 5 points plus a bilinear affine warp.

Normalisation differs per model and fails silently if you get it wrong. InsightFace recognizers take (x−127.5)/127.5 in RGB. PhotoPrism records SFace as `Uniform(0, 1)` in RGB and notes that YuNet takes raw 0–255 **BGR** while SCRFD takes normalised RGB ([face README](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/README.md), [models.go](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/models.go)).

---

## 5. Clustering embeddings into people

- **Immich:** incremental, DBSCAN-like. A face is a "core" face if it has at least `minFaces` (default 3) neighbours within `maxDistance` (default 0.5, cosine) found through a vector search. Non-core faces are deferred and attached later ([person.service.ts](https://github.com/immich-app/immich/blob/main/server/src/services/person.service.ts); defaults in [config.dto.ts](https://github.com/immich-app/immich/blob/main/server/src/dtos/config.dto.ts): `modelName: 'buffalo_l', minScore: 0.7, maxDistance: 0.5, minFaces: 3`).
- **PhotoPrism:** DBSCAN with `FACE_CLUSTER_CORE` = 5. It caps cluster width separately because "DBSCAN links a face to a *neighbor*, so a line of bridge faces chains two people into one group". Thresholds are calibrated per model ([face README](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/README.md)).
- **LibrePhotos:** HDBSCAN, ported to numpy from `hdbscan` 0.8.44 ([hdbscan.py](https://github.com/LibrePhotos/librephotos/blob/dev/apps/backend/api/faces/hdbscan.py)).
- Chinese Whispers (dlib) is another option. It is not used by any of the apps checked here.
- Distance thresholds **do not transfer between models**. PhotoPrism measured SFace at TAR 0.7934 with FaceNet's thresholds and 0.9603 with its own.

---

## 6. Licence caveats

| Item | What the owner says | Where |
|---|---|---|
| InsightFace code | "released under the MIT License. There is no limitation for both academic and commercial usage." | [README#license](https://github.com/deepinsight/insightface/blob/master/README.md) |
| InsightFace pretrained models (buffalo_*, antelopev2, SCRFD weights) | "The training data containing the annotation (and the models trained with these data) are available for non-commercial research purposes only." / "The pretrained models provided with this library are for non-commercial research only, whether downloaded automatically or manually." Licensing contact: recognition-oss-pack@insightface.ai | [README](https://github.com/deepinsight/insightface/blob/master/README.md), [python-package README](https://github.com/deepinsight/insightface/blob/master/python-package/README.md#license) |
| Immich's buffalo_l mirror | `license: other`, `license_name: insightface`, linking back to the clause above | [HF card](https://huggingface.co/immich-app/buffalo_l) |
| PhotoPrism's reading | "The InsightFace ArcFace weights are not published under an OSI-approved license and are therefore never bundled". The installer requires `INSIGHTFACE_ACCEPT_LICENSE=1` | [face README](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/README.md) |
| WebFace260M (EdgeFace, AdaFace, buffalo's WebFace600K is a WebFace-derived set **[unverified]**) | "we provide strict access for qualified research groups that sign the license, and try our best to guarantee WebFace260M for research purposes only" | [arXiv 2204.10149](https://arxiv.org/abs/2204.10149), broader-impact section. The official terms page (face-benchmark.org) failed TLS and was **not read** |
| AuraFace | Apache-2.0. **But** the HF repo also contains `scrfd_10g_bnkps.onnx` (16,923,827 bytes, the same size as InsightFace's `det_10g`), `2d106det.onnx`, `1k3d68.onnx` and `genderage.onnx`. These look like InsightFace's own non-commercial weights redistributed under the repo's Apache label. **Use only `glintr100.onnx`**, and pair it with YuNet | [file listing](https://huggingface.co/fal/AuraFace-v1/tree/main) |
| SFace / YuNet | Apache-2.0 / MIT. OpenCV Zoo: "Please refer to licenses of different models." SFace training data is undisclosed | [OpenCV Zoo README](https://github.com/opencv/opencv_zoo#license) |
| LVFace | MIT badge, but the prose says the models are non-commercial research only: **contradictory** | [README](https://github.com/bytedance/LVFace#license) |
| dlib models | Public domain (CC0), except the 68-point landmark model (iBUG, non-commercial) | [dlib-models](https://github.com/davisking/dlib-models) |
| MS-Celeb-1M (MS1MV2/V3) | Widely reported as withdrawn by Microsoft in 2019 **[secondary/unverified — no Microsoft primary source checked]** | — |

A secondary source that roughly agrees: UniFace's licence page lists ArcFace and SCRFD weights as "non-commercial only", and EdgeFace and AdaFace weights as BSD-3/MIT with WebFace260M data restrictions ([UniFace licence attribution](https://yakhyo.github.io/uniface/license-attribution/)) **[secondary]**.

**Practical reading for this project.** A private family viewer that is never sold or distributed is non-commercial. Whether it counts as "research" is not defined anywhere in InsightFace's text. If the repo is ever published with the weights inside the Docker image, that is *redistribution*. Immich avoids this by downloading at first run from its own HF mirror. PhotoPrism avoids it by requiring the operator to run a gated installer. Do one of those, or email InsightFace.

---

## 7. What self-hosted photo apps actually use (verified in source)

| App | Detector | Recognizer | Runtime | Clustering | Source |
|---|---|---|---|---|---|
| **Immich** (v3.3.5, 2026-10-21) | SCRFD from the InsightFace pack | `buffalo_l` default; also `buffalo_s`, `buffalo_m`, `antelopev2` | Python ML sidecar, ONNX Runtime (also ArmNN/RKNN) | DBSCAN-like incremental via pgvector | [constants.py](https://github.com/immich-app/immich/blob/main/machine-learning/immich_ml/models/constants.py), [detection.py](https://github.com/immich-app/immich/blob/main/machine-learning/immich_ml/models/facial_recognition/detection.py), [recognition.py](https://github.com/immich-app/immich/blob/main/machine-learning/immich_ml/models/facial_recognition/recognition.py), [config.dto.ts](https://github.com/immich-app/immich/blob/main/server/src/dtos/config.dto.ts) |
| **PhotoPrism** (`develop`, README dated 2026-10-06) | YuNet `2026may` (MIT) default; SCRFD `det_500m` optional, gated | **SFace default**; AuraFace optional (Apache-2.0, manual download); `arcface_r50`/`arcface_mbf` gated "non-free"; legacy FaceNet (TensorFlow) | Go + ONNX Runtime (`yalue/onnxruntime_go`) | DBSCAN, per-model thresholds | [face README](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/README.md), [models.go](https://github.com/photoprism/photoprism/blob/develop/internal/ai/face/models.go) |
| **LibrePhotos** (`dev`) | SCRFD (InsightFace pack) | `buffalo_sc` **default**; `buffalo_s/m/l`, `antelopev2` supported | Python face sidecar, InsightFace 0.7.3 logic ported onto ONNX Runtime | HDBSCAN | [main.py](https://github.com/LibrePhotos/librephotos/blob/dev/apps/backend/service/face_recognition/main.py), [face_analysis.py](https://github.com/LibrePhotos/librephotos/blob/dev/apps/backend/service/face_recognition/face_analysis.py) |
| **digiKam** (`master`) | YuNet (`cv::FaceDetectorYN`) | SFace | C++ OpenCV DNN | own classifier | [dnnfacedetectoryunet.cpp](https://invent.kde.org/graphics/digikam/-/blob/master/core/libs/facesengine/detection/opencv-dnn/dnnfacedetectoryunet.cpp), [dnnsfaceextractor.cpp](https://invent.kde.org/graphics/digikam/-/blob/master/core/libs/facesengine/recognition/opencv-dnn/dnnsfaceextractor.cpp) |

PhotoPrism's latest release notes (`261007-65faaae5d`, 2026-10-07) already call FaceNet "the legacy FaceNet face model" ([releases](https://github.com/photoprism/photoprism/releases)). Whether SFace is the default in that *release*, rather than only on `develop`, was **not confirmed**.

The pattern: apps willing to rely on InsightFace's terms (Immich, LibrePhotos) use the buffalo packs. Apps that require OSI-licensed weights (PhotoPrism, digiKam) use YuNet + SFace.

---

## 8. Node.js integration path (no Python sidecar needed)

**Recommended: `onnxruntime-node` with hand-written pre- and post-processing.**
- `onnxruntime-node` 1.30.0 (2026-09-14, MIT) ships prebuilt CPU binaries for Linux x64 and arm64. It "works on Node.js v16.x+ (recommend v20.x+)" ([js/node README](https://github.com/microsoft/onnxruntime/blob/main/js/node/README.md)). **Node 26 is not mentioned** (see open questions).
- Install note: "By default, the CUDA EP binaries are installed automatically when you install the package". Pass `--onnxruntime-node-install=skip` to avoid that download in a CPU-only Docker build (same README).
- All candidate models (buffalo_* `det_*.onnx` / `w600k_*.onnx`, YuNet, SFace, AuraFace `glintr100.onnx`) are plain ONNX and load directly.
- The pipeline to write in TS mirrors Immich's ~150 lines of Python ([detection.py](https://github.com/immich-app/immich/blob/main/machine-learning/immich_ml/models/facial_recognition/detection.py), [_ops.py](https://github.com/immich-app/immich/blob/main/machine-learning/immich_ml/models/facial_recognition/_ops.py), [recognition.py](https://github.com/immich-app/immich/blob/main/machine-learning/immich_ml/models/facial_recognition/recognition.py)):
  1. Decode the Photo. The repo already decodes it with `jpeg-js` and `heic-decode` (package.json), and the EXIF orientation is applied already.
  2. Letterbox to 640×640 and normalise ((x−127.5)/128 for SCRFD).
  3. Run the detector, then decode SCRFD heads at strides 8/16/32 with 2 anchors per cell, then apply a score threshold (Immich uses 0.7) and NMS.
  4. Umeyama-align each face to 112×112 (§4) and batch the crops into the recognizer.
  5. L2-normalise the embeddings and compare them by cosine.
- Swap in YuNet + SFace or AuraFace by changing steps 2–3 (YuNet decode, BGR 0–255) and the normalisation.

**Alternatives considered:**
- *OpenCV for Node* (`@u4/opencv4nodejs` 7.1.2, last npm release 2024-09-13): this would give `FaceDetectorYN`/`FaceRecognizerSF` from OpenCV ≥4.5.4, but it needs a native OpenCV build in the image. Whether the binding exposes those classes was **not verified**.
- *@vladmandic/human* 3.3.6 (npm 2025-08-26, repo last pushed 2025-12-13, MIT): TFJS-based, using BlazeFace with FaceRes/MobileFaceNet descriptors. "Included models are included under license inherited from the original model source" ([wiki](https://github.com/vladmandic/human/wiki/Models)). It publishes no LFW/IJB numbers for its descriptors, and it pulls in `tfjs-node`.
- *face-api.js*: last npm release 0.22.2 on 2020-03-22, so it is abandoned. Its successor `@vladmandic/face-api` is **archived** (GitHub, 2025-02).
- *transformers.js* (`@huggingface/transformers` 4.3.1): no face-detection or face-recognition pipeline was found for it **[not exhaustively checked]**.
- *Python sidecar running `insightface`*: the most turnkey option, but it adds a second runtime to the pixi/Docker setup for something ONNX Runtime does natively. Immich and LibrePhotos both had to re-implement InsightFace's glue themselves anyway.

**ADR-0001 checklist for any of these:**
- Bake the model files into the image, or into a volume populated at build time, and pin their SHA256 (PhotoPrism pins `0ba9fbfa…` for SFace). Never let `insightface` or any other library auto-download at runtime. The pip package downloads from GitHub releases ([model_zoo.md](https://github.com/deepinsight/insightface/blob/master/python-package/docs/model_zoo.md#automatic-downloads)).
- Inference is fully local, and no Photo data leaves the server. **OK.**
- **Not OK without a new ADR:** storing embeddings, clusters or names after the response. Children's face embeddings are durable biometric data derived from Photos, which goes against "never retained".

---

## 9. Open questions

1. **ADR:** does the project want cross-Photo recognition at all? If so, write ADR-0002 covering where embeddings live, how they are deleted, and who can see them. Per-Photo detection only ("3 faces found", boxes drawn) fits ADR-0001 as it stands.
2. **InsightFace licence scope:** does "non-commercial research" cover a private family app? Only InsightFace can answer: recognition-oss-pack@insightface.ai.
3. **CPU latency on the actual home server** for `buffalo_l` vs `buffalo_s` vs AuraFace vs SFace under `onnxruntime-node`. Apart from OpenCV Zoo's SFace/YuNet numbers and the SCRFD single-thread figure, no primary source publishes CPU timings for these packs. Measure with a few real family photos.
4. **Children:** no candidate publishes YLFW or similar child-face results. A small labelled sample of our own children across ages would show which model splits them least.
5. **onnxruntime-node on Node 26:** the README only states v16+. Confirm that prebuilt N-API binaries load under Node 26 in the pixi environment.
6. **SFace and AuraFace training data:** both undisclosed. "Apache-2.0 weights" does not settle the training-data question.
7. **Is buffalo's WebFace600K a WebFace260M subset** (and so under that dataset's research-only terms)? Not stated in any source read here.
8. **EdgeFace / FaceLiVTv2 ONNX export:** they are attractive on accuracy per FLOP, but neither ships ONNX, and both inherit WebFace or Glint360K data terms.
