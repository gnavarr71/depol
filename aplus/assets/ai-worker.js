import {
  AutoTokenizer,
  CLIPTextModelWithProjection,
  AutoProcessor,
  CLIPVisionModelWithProjection,
  RawImage,
  dot,
  softmax,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

const MODEL_ID = "Xenova/clip-vit-base-patch32";
const LOGIT_SCALE = Math.exp(4.6052);

const PROMPTS = [
  { group: "environment", text: "a wide photograph of a real indoor or outdoor environment" },
  { group: "environment", text: "a photograph showing a place and its surrounding space" },
  { group: "environment", text: "a room, street, landscape, building interior, cityscape, or natural scene" },
  { group: "environment", text: "a contextual real-world scene with a visible background" },
  { group: "environment", text: "a photograph taken within a recognizable location" },

  { group: "other", text: "an isolated object or product on a plain studio background" },
  { group: "other", text: "a close-up portrait or isolated person without a surrounding environment" },
  { group: "other", text: "a logo, icon, illustration, poster, screenshot, document, chart, or text graphic" },
  { group: "other", text: "an abstract image, texture, pattern, macro detail, or extreme close-up" },
  { group: "other", text: "a cutout subject with no visible place or spatial surroundings" },

  { group: "person", text: "a person is visible in the image" },
  { group: "person", text: "a human face or head is visible" },
  { group: "person", text: "a human hand or arm is visible" },
  { group: "person", text: "a human leg, foot, or partial human body is visible" },
  { group: "person", text: "part of a person appears at the edge of the frame" },
  { group: "person", text: "a human silhouette, reflection, or crowd is visible" },

  { group: "no_person", text: "no person and no human body part is visible" },
  { group: "no_person", text: "an empty place containing only objects, buildings, plants, or animals" },
  { group: "no_person", text: "a scene without any humans" },
];

let tokenizer = null;
let processor = null;
let visionModel = null;
let textEmbeddings = null;
let loadingPromise = null;
let runtime = null;

try {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
} catch {
  // Defaults remain usable if a future version changes these fields.
}

self.onmessage = async (event) => {
  const { type, requestId } = event.data || {};
  try {
    if (type === "init") {
      await ensureLoaded();
      postMessage({ type: "ready", requestId, runtime });
      return;
    }

    if (type === "classify") {
      await ensureLoaded();
      const result = await classifyFile(event.data.file);
      postMessage({ type: "result", requestId, result });
      return;
    }

    throw new Error("Mensaje de trabajo no reconocido.");
  } catch (error) {
    postMessage({
      type: "error",
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

function ensureLoaded() {
  if (!loadingPromise) loadingPromise = loadModel();
  return loadingPromise;
}

async function loadModel() {
  postStatus("loading", "Preparando el analizador local");

  tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID, {
    progress_callback: progressCallback,
  });
  processor = await AutoProcessor.from_pretrained(MODEL_ID, {
    progress_callback: progressCallback,
  });

  const webGpuConfig = await getWebGpuConfig();
  const candidates = webGpuConfig
    ? [webGpuConfig, { device: "wasm", textDtype: "q8", visionDtype: "q8", label: "WASM Q8" }]
    : [{ device: "wasm", textDtype: "q8", visionDtype: "q8", label: "WASM Q8" }];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      await loadModelsForRuntime(candidate);
      runtime = candidate.label;
      postStatus("ready", `Modelo listo con ${runtime}`);
      return;
    } catch (error) {
      lastError = error;
      await disposeModels();
      postStatus("fallback", `No se pudo usar ${candidate.label}; probando una alternativa`);
    }
  }

  throw lastError || new Error("No se pudo cargar el modelo de visión.");
}

async function getWebGpuConfig() {
  if (!self.navigator?.gpu) return null;
  try {
    const adapter = await self.navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const supportsFp16 = adapter.features?.has("shader-f16");
    return {
      device: "webgpu",
      textDtype: supportsFp16 ? "fp16" : "fp32",
      visionDtype: supportsFp16 ? "fp16" : "fp32",
      label: supportsFp16 ? "WebGPU FP16" : "WebGPU FP32",
    };
  } catch {
    return null;
  }
}

async function loadModelsForRuntime(config) {
  postStatus("loading", `Cargando codificador de texto (${config.label})`);
  let textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, {
    device: config.device,
    dtype: config.textDtype,
    progress_callback: progressCallback,
  });

  try {
    const texts = PROMPTS.map((item) => item.text);
    const inputs = tokenizer(texts, { padding: true, truncation: true });
    let textOutput = null;
    let normalizedTextEmbeds = null;
    try {
      textOutput = await textModel(inputs);
      const textEmbeds = textOutput.text_embeds;
      normalizedTextEmbeds = textEmbeds.normalize();
      textEmbeddings = normalizedTextEmbeds.tolist();
    } finally {
      if (normalizedTextEmbeds && normalizedTextEmbeds !== textOutput?.text_embeds) {
        normalizedTextEmbeds.dispose?.();
      }
      disposeTensorMap(textOutput);
      disposeTensorMap(inputs);
    }
  } finally {
    await textModel.dispose?.();
    textModel = null;
  }

  postStatus("loading", `Cargando codificador de imagen (${config.label})`);
  visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
    device: config.device,
    dtype: config.visionDtype,
    progress_callback: progressCallback,
  });
}

async function classifyFile(file) {
  if (!(file instanceof Blob)) throw new Error("El archivo recibido no es una imagen válida.");
  const objectUrl = URL.createObjectURL(file);
  let image = null;
  let imageInputs = null;
  let imageOutput = null;
  let normalizedImageEmbeds = null;

  try {
    image = await RawImage.read(objectUrl);
    imageInputs = await processor(image);
    imageOutput = await visionModel(imageInputs);
    normalizedImageEmbeds = imageOutput.image_embeds.normalize();
    const imageEmbedding = normalizedImageEmbeds.tolist()[0];
    const similarities = textEmbeddings.map((embedding) => dot(embedding, imageEmbedding));

    const environmentScore = topMean(similarities, "environment", 2);
    const otherScore = topMean(similarities, "other", 2);
    const personScore = topMean(similarities, "person", 2);
    const noPersonScore = topMean(similarities, "no_person", 2);

    const environmentProbability = softmax([environmentScore * LOGIT_SCALE, otherScore * LOGIT_SCALE])[0];
    const personProbability = softmax([personScore * LOGIT_SCALE, noPersonScore * LOGIT_SCALE])[0];

    return {
      environmentProbability,
      personProbability,
      diagnostics: {
        environmentScore,
        otherScore,
        personScore,
        noPersonScore,
      },
      runtime,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
    if (normalizedImageEmbeds && normalizedImageEmbeds !== imageOutput?.image_embeds) {
      normalizedImageEmbeds.dispose?.();
    }
    disposeTensorMap(imageOutput);
    disposeTensorMap(imageInputs);
    image?.dispose?.();
  }
}

function topMean(similarities, group, count) {
  const values = [];
  for (let index = 0; index < PROMPTS.length; index += 1) {
    if (PROMPTS[index].group === group) values.push(similarities[index]);
  }
  values.sort((a, b) => b - a);
  const selected = values.slice(0, Math.max(1, Math.min(count, values.length)));
  return selected.reduce((sum, value) => sum + value, 0) / selected.length;
}

function disposeTensorMap(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (typeof value.dispose === "function") {
    try {
      value.dispose();
    } catch {
      // Cleanup should never mask a classification result or a more useful error.
    }
    return;
  }

  for (const item of Object.values(value)) disposeTensorMap(item, seen);
}

async function disposeModels() {
  try {
    await visionModel?.dispose?.();
  } catch {
    // Ignore cleanup failures during a runtime fallback.
  }
  visionModel = null;
  textEmbeddings = null;
}

function progressCallback(progress) {
  const safe = {
    status: progress?.status || "progress",
    file: progress?.file || progress?.name || "",
    progress: Number.isFinite(progress?.progress) ? progress.progress : null,
    loaded: Number.isFinite(progress?.loaded) ? progress.loaded : null,
    total: Number.isFinite(progress?.total) ? progress.total : null,
  };
  postMessage({ type: "model-progress", data: safe });
}

function postStatus(status, detail) {
  postMessage({ type: "model-status", status, detail });
}
