import {
  addAiSuffix,
  detectFormat,
  writeSyntheticPerformerMetadata,
} from "./metadata.js";

const CATEGORY = Object.freeze({
  ENVIRONMENT_PEOPLE: "environment_people",
  ENVIRONMENT_EMPTY: "environment_no_people",
  OTHER: "other",
});

const CATEGORY_LABELS = Object.freeze({
  [CATEGORY.ENVIRONMENT_PEOPLE]: "Entorno con personas",
  [CATEGORY.ENVIRONMENT_EMPTY]: "Entorno sin personas",
  [CATEGORY.OTHER]: "Sin cambios",
});

const WORKER_TIMEOUT_MS = Object.freeze({
  init: 15 * 60 * 1000,
  classify: 4 * 60 * 1000,
});

const dom = {
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  chooseButton: document.getElementById("chooseButton"),
  clearButton: document.getElementById("clearButton"),
  notice: document.getElementById("notice"),
  queueSection: document.getElementById("queueSection"),
  queueSummary: document.getElementById("queueSummary"),
  fileList: document.getElementById("fileList"),
  environmentThreshold: document.getElementById("environmentThreshold"),
  environmentThresholdValue: document.getElementById("environmentThresholdValue"),
  personThreshold: document.getElementById("personThreshold"),
  personThresholdValue: document.getElementById("personThresholdValue"),
  autoDownload: document.getElementById("autoDownload"),
  progressPanel: document.getElementById("progressPanel"),
  progressEyebrow: document.getElementById("progressEyebrow"),
  progressTitle: document.getElementById("progressTitle"),
  progressPercent: document.getElementById("progressPercent"),
  progressBar: document.getElementById("progressBar"),
  progressDetail: document.getElementById("progressDetail"),
  actionTitle: document.getElementById("actionTitle"),
  actionSubtitle: document.getElementById("actionSubtitle"),
  processButton: document.getElementById("processButton"),
  downloadAgainButton: document.getElementById("downloadAgainButton"),
  runtimeStatus: document.getElementById("runtimeStatus"),
};

const state = {
  items: [],
  busy: false,
  modelReady: false,
  modelRuntime: null,
  modelInitPromise: null,
  worker: null,
  pendingWorkerRequests: new Map(),
  lastZipBlob: null,
  lastZipUrl: null,
  lastZipName: null,
  zipDirty: true,
};

initialize();

function initialize() {
  bindEvents();
  updateThresholdLabels();
  render();
  createWorker();

  if (!window.JSZip) {
    showNotice("No se ha podido cargar el generador ZIP incluido con la aplicación.", "error");
    dom.processButton.disabled = true;
  }
}

function bindEvents() {
  dom.chooseButton.addEventListener("click", (event) => {
    event.stopPropagation();
    dom.fileInput.click();
  });

  dom.dropZone.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", () => {
    addFiles([...dom.fileInput.files]);
    dom.fileInput.value = "";
  });

  for (const eventName of ["dragenter", "dragover"]) {
    dom.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!state.busy) dom.dropZone.classList.add("is-dragging");
    });
  }

  dom.dropZone.addEventListener("dragleave", (event) => {
    if (!dom.dropZone.contains(event.relatedTarget)) dom.dropZone.classList.remove("is-dragging");
  });

  dom.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dom.dropZone.classList.remove("is-dragging");
    if (!state.busy) addFiles([...event.dataTransfer.files]);
  });

  dom.clearButton.addEventListener("click", clearFiles);
  dom.processButton.addEventListener("click", processBatch);
  dom.downloadAgainButton.addEventListener("click", downloadLastZip);

  dom.environmentThreshold.addEventListener("input", thresholdsChanged);
  dom.personThreshold.addEventListener("input", thresholdsChanged);

  dom.fileList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-id]");
    if (!button || state.busy) return;
    removeFile(button.dataset.removeId);
  });

  dom.fileList.addEventListener("change", (event) => {
    const select = event.target.closest("[data-choice-id]");
    if (!select) return;
    const item = state.items.find((entry) => entry.id === select.dataset.choiceId);
    if (!item) return;
    item.manualCategory = select.value === "auto" ? null : select.value;
    invalidateZip();
    render();
  });

  window.addEventListener("beforeunload", cleanupUrls);
}

function createWorker() {
  if (state.worker) return state.worker;

  try {
    const worker = new Worker(new URL("./ai-worker.js", import.meta.url), { type: "module" });
    state.worker = worker;
    worker.addEventListener("message", handleWorkerMessage);
    worker.addEventListener("error", (event) => {
      const message = event.message || "No se pudo iniciar el módulo de inteligencia artificial.";
      if (state.worker === worker) {
        state.worker = null;
        state.modelReady = false;
        state.modelRuntime = null;
        state.modelInitPromise = null;
      }
      rejectAllWorkerRequests(message);
      setRuntimeStatus("error", "Error al cargar el modelo");
    });
    return worker;
  } catch (error) {
    state.worker = null;
    setRuntimeStatus("error", "Navegador no compatible");
    showNotice(
      `No se pudo iniciar el analizador local: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
    return null;
  }
}

function handleWorkerMessage(event) {
  const message = event.data || {};

  if (message.type === "model-progress") {
    handleModelProgress(message.data);
    return;
  }

  if (message.type === "model-status") {
    handleModelStatus(message.status, message.detail);
    return;
  }

  const pending = state.pendingWorkerRequests.get(message.requestId);
  if (!pending) return;
  state.pendingWorkerRequests.delete(message.requestId);
  clearTimeout(pending.timeoutId);

  if (message.type === "error") pending.reject(new Error(message.error || "Error del analizador."));
  else pending.resolve(message);
}

function sendWorkerRequest(type, payload = {}) {
  const worker = state.worker || createWorker();
  if (!worker) return Promise.reject(new Error("El analizador local no está disponible."));

  const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const timeoutMs = WORKER_TIMEOUT_MS[type] || WORKER_TIMEOUT_MS.classify;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const pending = state.pendingWorkerRequests.get(requestId);
      if (!pending) return;
      state.pendingWorkerRequests.delete(requestId);
      pending.reject(
        new Error(
          type === "init"
            ? "La carga del modelo ha superado el tiempo máximo permitido."
            : "El análisis de la imagen ha superado el tiempo máximo permitido.",
        ),
      );
    }, timeoutMs);

    state.pendingWorkerRequests.set(requestId, { resolve, reject, timeoutId });
    try {
      worker.postMessage({ type, requestId, ...payload });
    } catch (error) {
      clearTimeout(timeoutId);
      state.pendingWorkerRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function rejectAllWorkerRequests(message) {
  for (const pending of state.pendingWorkerRequests.values()) {
    clearTimeout(pending.timeoutId);
    pending.reject(new Error(message));
  }
  state.pendingWorkerRequests.clear();
}

async function ensureModel() {
  if (state.modelReady) return;
  if (!state.modelInitPromise) {
    setRuntimeStatus("loading", "Cargando modelo");
    state.modelInitPromise = sendWorkerRequest("init")
      .then((message) => {
        state.modelReady = true;
        state.modelRuntime = message.runtime || "navegador";
        setRuntimeStatus("ready", `Modelo listo \u00b7 ${state.modelRuntime}`);
      })
      .catch((error) => {
        state.modelInitPromise = null;
        setRuntimeStatus("error", "Error al cargar el modelo");
        throw error;
      });
  }
  await state.modelInitPromise;
}

function handleModelProgress(progress) {
  if (!state.busy) return;
  const rawProgress = Number(progress?.progress);
  const percent = Number.isFinite(rawProgress) ? clamp(rawProgress, 0, 100) : 0;
  const mapped = 5 + percent * 0.3;
  const fileName = String(progress?.file || "").split("/").pop();
  setProgress(
    "Cargando IA",
    "Descargando y preparando el modelo",
    mapped,
    fileName ? `${fileName} \u00b7 ${Math.round(percent)}%` : "La primera carga puede tardar más; después se reutiliza la caché.",
  );
}

function handleModelStatus(status, detail) {
  if (status === "ready") setRuntimeStatus("ready", detail || "Modelo listo");
  else if (status === "fallback") setRuntimeStatus("loading", detail || "Cambiando de motor");
  else setRuntimeStatus("loading", detail || "Cargando modelo");

  if (state.busy && detail) {
    setProgress("Cargando IA", "Preparando el analizador local", 8, detail);
  }
}

function addFiles(files) {
  if (!files.length) return;
  const existingKeys = new Set(state.items.map((item) => fileKey(item.file)));
  let unsupported = 0;
  let duplicates = 0;
  let empty = 0;

  for (const file of files) {
    if (!isSupportedImage(file)) {
      unsupported += 1;
      continue;
    }
    if (!file.size) {
      empty += 1;
      continue;
    }
    const key = fileKey(file);
    if (existingKeys.has(key)) {
      duplicates += 1;
      continue;
    }

    existingKeys.add(key);
    state.items.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
      phase: "pending",
      scores: null,
      suggestedCategory: null,
      manualCategory: null,
      error: null,
      warning: null,
      outputName: null,
    });
  }

  invalidateZip();
  render();

  const messages = [];
  if (unsupported) messages.push(`${unsupported} archivo(s) omitido(s) por formato no compatible`);
  if (duplicates) messages.push(`${duplicates} duplicado(s) omitido(s)`);
  if (empty) messages.push(`${empty} archivo(s) vacío(s) omitido(s)`);
  if (messages.length) showNotice(`${messages.join("; ")}.`, "warning");
  else hideNotice();

  const totalSize = state.items.reduce((sum, item) => sum + item.file.size, 0);
  if (totalSize > 700 * 1024 * 1024) {
    showNotice("El lote supera 700 MB. El navegador puede necesitar bastante memoria para crear el ZIP.", "warning");
  }
}

function removeFile(id) {
  const index = state.items.findIndex((item) => item.id === id);
  if (index < 0) return;
  URL.revokeObjectURL(state.items[index].previewUrl);
  state.items.splice(index, 1);
  invalidateZip();
  render();
}

function clearFiles() {
  if (state.busy) return;
  for (const item of state.items) URL.revokeObjectURL(item.previewUrl);
  state.items = [];
  invalidateZip();
  hideNotice();
  dom.progressPanel.hidden = true;
  dom.progressBar.style.width = "0%";
  dom.progressPercent.textContent = "0%";
  render();
}

function thresholdsChanged() {
  updateThresholdLabels();
  for (const item of state.items) {
    if (item.scores) item.suggestedCategory = decideCategory(item.scores);
  }
  invalidateZip();
  render();
}

function updateThresholdLabels() {
  dom.environmentThresholdValue.value = `${Math.round(Number(dom.environmentThreshold.value) * 100)}%`;
  dom.personThresholdValue.value = `${Math.round(Number(dom.personThreshold.value) * 100)}%`;
}

function decideCategory(scores) {
  const environmentThreshold = Number(dom.environmentThreshold.value);
  const personThreshold = Number(dom.personThreshold.value);
  if (scores.environmentProbability < environmentThreshold) return CATEGORY.OTHER;
  return scores.personProbability >= personThreshold
    ? CATEGORY.ENVIRONMENT_PEOPLE
    : CATEGORY.ENVIRONMENT_EMPTY;
}

function effectiveCategory(item) {
  return item.manualCategory || item.suggestedCategory || CATEGORY.OTHER;
}

async function processBatch() {
  if (state.busy || !state.items.length) return;
  state.busy = true;
  hideNotice();
  dom.progressPanel.hidden = false;
  setProgress("Preparando", "Cargando el modelo de análisis", 3, "Las imágenes permanecerán dentro de este navegador.");
  render();

  try {
    const pendingItems = state.items.filter((item) => !item.scores && !item.manualCategory);
    if (pendingItems.length) await ensureModel();

    for (let index = 0; index < pendingItems.length; index += 1) {
      const item = pendingItems[index];
      item.phase = "analyzing";
      item.error = null;
      render();

      const startPercent = 35 + (index / pendingItems.length) * 43;
      setProgress(
        "Analizando imágenes",
        `Procesando ${index + 1} de ${pendingItems.length}`,
        startPercent,
        item.file.name,
      );

      try {
        const message = await sendWorkerRequest("classify", { file: item.file });
        item.scores = message.result;
        item.suggestedCategory = decideCategory(item.scores);
        item.phase = "ready";
        if (message.result.runtime) state.modelRuntime = message.result.runtime;
      } catch (error) {
        item.phase = "error";
        item.error = error instanceof Error ? error.message : String(error);
        item.suggestedCategory = CATEGORY.OTHER;
      }
      render();
    }

    await buildZip();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const item of state.items) {
      if (!item.scores && !item.manualCategory) {
        item.phase = "error";
        item.error = `Analizador no disponible: ${message}`;
      }
    }
    showNotice(`No se pudo completar el proceso automático: ${message}. Puedes asignar una decisión manual y generar el ZIP.`, "error");
    setProgress("Proceso detenido", "No se pudo completar el lote", 0, message);
  } finally {
    state.busy = false;
    render();
  }
}

async function buildZip() {
  const zip = new window.JSZip();
  const usedNames = new Set();
  let metadataWarnings = 0;
  let processingErrors = 0;

  for (let index = 0; index < state.items.length; index += 1) {
    const item = state.items[index];
    const category = effectiveCategory(item);
    const basePercent = 78 + (index / Math.max(1, state.items.length)) * 8;
    setProgress("Preparando archivos", `Aplicando cambios ${index + 1} de ${state.items.length}`, basePercent, item.file.name);

    let bytes = new Uint8Array(await item.file.arrayBuffer());
    let outputName = category === CATEGORY.OTHER ? item.file.name : addAiSuffix(item.file.name);
    item.warning = null;
    item.outputName = outputName;

    if (category === CATEGORY.ENVIRONMENT_PEOPLE) {
      try {
        const result = writeSyntheticPerformerMetadata(bytes, item.file.type || item.file.name);
        bytes = result.bytes;
        item.warning = result.warning;
        if (result.warning) metadataWarnings += 1;
      } catch (error) {
        processingErrors += 1;
        item.warning = `No se pudo escribir XMP; se incluyó el original: ${error instanceof Error ? error.message : String(error)}`;
        bytes = new Uint8Array(await item.file.arrayBuffer());
        outputName = item.file.name;
        item.outputName = outputName;
      }
    }

    const uniqueName = makeUniqueZipName(sanitizeZipFilename(outputName), usedNames);
    zip.file(uniqueName, bytes, {
      binary: true,
      date: new Date(item.file.lastModified || Date.now()),
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
  }

  render();
  setProgress("Creando ZIP", "Comprimiendo todas las imágenes", 87, "El archivo se genera localmente.");

  const blob = await zip.generateAsync(
    {
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      mimeType: "application/zip",
    },
    (metadata) => {
      const percent = 87 + clamp(metadata.percent || 0, 0, 100) * 0.13;
      setProgress("Creando ZIP", "Comprimiendo todas las imágenes", percent, metadata.currentFile || "Finalizando archivo ZIP");
    },
  );

  if (state.lastZipUrl) URL.revokeObjectURL(state.lastZipUrl);
  state.lastZipBlob = blob;
  state.lastZipUrl = URL.createObjectURL(blob);
  state.lastZipName = buildZipName();
  state.zipDirty = false;

  setProgress("Completado", "ZIP listo para descargar", 100, `${state.items.length} imagen(es) \u00b7 ${formatBytes(blob.size)}`);

  const summary = summarizeCategories();
  const detailParts = [
    `${summary.people} con metadato XMP`,
    `${summary.empty} renombradas`,
    `${summary.other} sin cambios`,
  ];
  if (metadataWarnings) detailParts.push(`${metadataWarnings} aviso(s) de metadatos`);
  if (processingErrors) detailParts.push(`${processingErrors} archivo(s) conservados por error`);
  showNotice(`ZIP preparado: ${detailParts.join(", ")}.`, processingErrors ? "warning" : "success");

  if (dom.autoDownload.checked) downloadLastZip();
}

function downloadLastZip() {
  if (!state.lastZipUrl || !state.lastZipName) return;
  const anchor = document.createElement("a");
  anchor.href = state.lastZipUrl;
  anchor.download = state.lastZipName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function render() {
  const hasFiles = state.items.length > 0;
  dom.queueSection.hidden = !hasFiles;
  dom.clearButton.hidden = !hasFiles || state.busy;
  dom.dropZone.setAttribute("aria-disabled", state.busy ? "true" : "false");
  dom.chooseButton.disabled = state.busy;
  dom.fileInput.disabled = state.busy;

  if (hasFiles) {
    const totalSize = state.items.reduce((sum, item) => sum + item.file.size, 0);
    dom.queueSummary.textContent = `${state.items.length} archivo(s) \u00b7 ${formatBytes(totalSize)}`;
  }

  renderFileList();
  updateActions();
}

function renderFileList() {
  const fragment = document.createDocumentFragment();

  for (const item of state.items) {
    const category = effectiveCategory(item);
    const card = document.createElement("article");
    card.className = "file-card";
    card.dataset.kind = item.phase === "error" && !item.manualCategory ? "error" : item.scores || item.manualCategory ? category : "pending";

    const thumb = document.createElement("img");
    thumb.className = "file-thumb";
    thumb.src = item.previewUrl;
    thumb.alt = "";

    const main = document.createElement("div");
    main.className = "file-main";
    const name = document.createElement("strong");
    name.className = "file-name";
    name.textContent = item.file.name;
    name.title = item.file.name;
    const meta = document.createElement("span");
    meta.className = "file-meta";
    meta.textContent = `${formatType(item.file)} \u00b7 ${formatBytes(item.file.size)}`;
    main.append(name, meta);

    const result = document.createElement("div");
    result.className = "file-result";
    const pill = document.createElement("span");
    pill.className = "status-pill";
    const detail = document.createElement("small");

    if (item.phase === "analyzing") {
      pill.classList.add("is-loading");
      pill.textContent = "Analizando";
      detail.textContent = "El modelo está revisando la imagen.";
    } else if (item.phase === "error" && !item.manualCategory) {
      pill.classList.add("is-error");
      pill.textContent = "Error de análisis";
      detail.textContent = item.error || "Se conservará el archivo sin cambios.";
    } else if (item.scores || item.manualCategory) {
      pill.textContent = CATEGORY_LABELS[category];
      if (category === CATEGORY.ENVIRONMENT_PEOPLE) pill.classList.add("is-person");
      else if (category === CATEGORY.ENVIRONMENT_EMPTY) pill.classList.add("is-empty");
      else pill.classList.add("is-other");
      detail.textContent = item.scores
        ? resultDetail(item, category)
        : `Decisión manual: ${CATEGORY_LABELS[category]}. No se ejecutará el análisis automático.`;
    } else {
      pill.textContent = "Pendiente";
      detail.textContent = "Aún no se ha analizado.";
    }

    if (item.warning) detail.textContent = `${detail.textContent} ${item.warning}`;
    result.append(pill, detail);

    const choice = document.createElement("div");
    choice.className = "file-choice";
    const choiceLabel = document.createElement("label");
    choiceLabel.htmlFor = `choice-${item.id}`;
    choiceLabel.textContent = "Decisión final";
    const select = document.createElement("select");
    select.id = `choice-${item.id}`;
    select.className = "file-select";
    select.dataset.choiceId = item.id;
    select.disabled = state.busy;

    const autoOption = document.createElement("option");
    autoOption.value = "auto";
    autoOption.textContent = item.suggestedCategory
      ? `Automático: ${CATEGORY_LABELS[item.suggestedCategory]}`
      : "Automático";
    select.appendChild(autoOption);

    for (const value of [CATEGORY.ENVIRONMENT_PEOPLE, CATEGORY.ENVIRONMENT_EMPTY, CATEGORY.OTHER]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = CATEGORY_LABELS[value];
      select.appendChild(option);
    }
    select.value = item.manualCategory || "auto";
    choice.append(choiceLabel, select);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.dataset.removeId = item.id;
    remove.disabled = state.busy;
    remove.setAttribute("aria-label", `Quitar ${item.file.name}`);
    remove.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M8 5V3.5h4V5m-6.5 0 .7 11h7.6l.7-11M8.3 8v5.5m3.4-5.5v5.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    card.append(thumb, main, result, choice, remove);
    fragment.appendChild(card);
  }

  dom.fileList.replaceChildren(fragment);
}

function resultDetail(item, category) {
  const environment = Math.round(item.scores.environmentProbability * 100);
  const person = Math.round(item.scores.personProbability * 100);
  const manual = item.manualCategory ? " Ajuste manual aplicado." : "";

  if (category === CATEGORY.ENVIRONMENT_PEOPLE) {
    return `Entorno ${environment}% \u00b7 persona o parte corporal ${person}%. Se renombrará y se añadirá XMP.${manual}`;
  }
  if (category === CATEGORY.ENVIRONMENT_EMPTY) {
    return `Entorno ${environment}% \u00b7 persona o parte corporal ${person}%. Se renombrará sin tocar metadatos.${manual}`;
  }
  return `Probabilidad de entorno ${environment}%. Se conservará el original.${manual}`;
}

function updateActions() {
  const hasFiles = state.items.length > 0;
  dom.processButton.disabled = !hasFiles || state.busy || !window.JSZip;
  dom.downloadAgainButton.hidden = !state.lastZipBlob || state.zipDirty || state.busy;

  if (!hasFiles) {
    dom.actionTitle.textContent = "Todo listo para empezar";
    dom.actionSubtitle.textContent = "Selecciona al menos una imagen.";
    dom.processButton.innerHTML = processButtonMarkup("Analizar y descargar ZIP");
    return;
  }

  if (state.busy) {
    dom.actionTitle.textContent = "Procesando el lote";
    dom.actionSubtitle.textContent = "No cierres esta pestaña hasta que termine la generación del ZIP.";
    dom.processButton.innerHTML = processButtonMarkup("Procesando...", true);
    return;
  }

  const pending = state.items.filter((item) => !item.scores && !item.manualCategory).length;
  if (pending) {
    dom.actionTitle.textContent = `${state.items.length} imagen(es) preparadas`;
    dom.actionSubtitle.textContent = `${pending} pendiente(s) de análisis. El ZIP se descargará al terminar.`;
    dom.processButton.innerHTML = processButtonMarkup("Analizar y descargar ZIP");
    return;
  }

  if (state.zipDirty) {
    dom.actionTitle.textContent = "Clasificación lista para revisar";
    dom.actionSubtitle.textContent = "Puedes corregir cualquier decisión antes de generar el ZIP.";
    dom.processButton.innerHTML = processButtonMarkup("Generar ZIP");
  } else {
    dom.actionTitle.textContent = "ZIP generado correctamente";
    dom.actionSubtitle.textContent = state.lastZipName || "El archivo está listo para descargar.";
    dom.processButton.innerHTML = processButtonMarkup("Generar de nuevo");
  }
}

function processButtonMarkup(label, spinning = false) {
  const icon = spinning
    ? '<svg viewBox="0 0 20 20" aria-hidden="true" style="animation:spin .8s linear infinite"><path d="M16 10a6 6 0 1 1-1.8-4.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.3v10.2m0 0 3.8-3.8M10 12.5 6.2 8.7M3 15.2v2.3h14v-2.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return `${icon}${label}`;
}

function setProgress(eyebrow, title, percent, detail) {
  dom.progressPanel.hidden = false;
  dom.progressEyebrow.textContent = eyebrow;
  dom.progressTitle.textContent = title;
  const safePercent = clamp(percent, 0, 100);
  dom.progressPercent.textContent = `${Math.round(safePercent)}%`;
  dom.progressBar.style.width = `${safePercent}%`;
  dom.progressDetail.textContent = detail || "";
}

function setRuntimeStatus(kind, text) {
  dom.runtimeStatus.className = `runtime-status is-${kind}`;
  dom.runtimeStatus.innerHTML = "<i></i>";
  dom.runtimeStatus.append(document.createTextNode(text));
}

function showNotice(message, type = "warning") {
  dom.notice.hidden = false;
  dom.notice.className = `notice${type === "error" ? " is-error" : type === "success" ? " is-success" : ""}`;
  dom.notice.textContent = message;
}

function hideNotice() {
  dom.notice.hidden = true;
  dom.notice.textContent = "";
  dom.notice.className = "notice";
}

function invalidateZip() {
  state.zipDirty = true;
  if (state.lastZipUrl) {
    URL.revokeObjectURL(state.lastZipUrl);
    state.lastZipUrl = null;
  }
  state.lastZipBlob = null;
  state.lastZipName = null;
  if (!state.busy) {
    dom.progressPanel.hidden = true;
    dom.progressBar.style.width = "0%";
    dom.progressPercent.textContent = "0%";
  }
}

function summarizeCategories() {
  const summary = { people: 0, empty: 0, other: 0 };
  for (const item of state.items) {
    const category = effectiveCategory(item);
    if (category === CATEGORY.ENVIRONMENT_PEOPLE) summary.people += 1;
    else if (category === CATEGORY.ENVIRONMENT_EMPTY) summary.empty += 1;
    else summary.other += 1;
  }
  return summary;
}

function makeUniqueZipName(filename, usedNames) {
  const dotIndex = filename.lastIndexOf(".");
  const hasExtension = dotIndex > 0;
  const stem = hasExtension ? filename.slice(0, dotIndex) : filename;
  const extension = hasExtension ? filename.slice(dotIndex) : "";
  let candidate = filename;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem} (${suffix})${extension}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function sanitizeZipFilename(filename) {
  const cleaned = String(filename || "imagen")
    .replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/^\.+$/, "imagen")
    .trim();
  return cleaned || "imagen";
}

function buildZipName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `imagenes_procesadas_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}.zip`;
}

function isSupportedImage(file) {
  const type = String(file.type || "").toLowerCase();
  if (["image/jpeg", "image/png", "image/webp"].includes(type)) return true;
  return /\.(jpe?g|png|webp)$/i.test(file.name) && Boolean(detectFormatHint(file.name));
}

function detectFormatHint(name) {
  const lower = String(name).toLowerCase();
  if (/\.jpe?g$/.test(lower)) return "jpeg";
  if (/\.png$/.test(lower)) return "png";
  if (/\.webp$/.test(lower)) return "webp";
  return null;
}

function formatType(file) {
  const format = detectFormatHint(file.name) || String(file.type).split("/").pop() || "imagen";
  return format === "jpeg" ? "JPG" : format.toUpperCase();
}

function fileKey(file) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let current = value / 1024;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  const digits = current >= 100 ? 0 : current >= 10 ? 1 : 2;
  return `${current.toFixed(digits)} ${units[index]}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function cleanupUrls() {
  for (const item of state.items) URL.revokeObjectURL(item.previewUrl);
  if (state.lastZipUrl) URL.revokeObjectURL(state.lastZipUrl);
}
