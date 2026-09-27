let detectorSessionPromise = null;
const recognizerSessionPromises = new Map();
const characterListPromises = new Map();
let activeRequestId = null;
let runtimeConfigured = false;

const OCR_SCALE = 3;
const OCR_PADDING = 18;
const OCR_MIN_SIDE = 900;
const OCR_MAX_SIDE = 2600;
const DETECTOR_MAX_SIDE = 1280;
const DETECTOR_THRESHOLD = 0.3;
const RECOGNIZER_HEIGHT = 48;
const RECOGNIZER_MAX_WIDTH = 2048;
const RECOGNIZER_MIN_WIDTH = 320;

const OCR_MODEL_ROOT = chrome.runtime.getURL("vendor/ppocr/");
const DETECTOR_MODEL_URL = OCR_MODEL_ROOT + "ch_PP-OCRv5_det_mobile.onnx";
const RECOGNIZER_CONFIGS = {
  ch: {
    model: OCR_MODEL_ROOT + "ch_PP-OCRv5_rec_mobile.onnx",
    dictionary: OCR_MODEL_ROOT + "ppocrv5_dict.txt"
  },
  korean: {
    model: OCR_MODEL_ROOT + "korean_PP-OCRv5_rec_mobile.onnx",
    dictionary: OCR_MODEL_ROOT + "ppocrv5_korean_dict.txt"
  }
};

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "offscreen" || message.action !== "ocr-recognize") return;
  recognizeRegion(message).catch((error) => {
    sendResult(message.requestId, { error: error.message || "OCR failed." });
  });
});

async function recognizeRegion(message) {
  activeRequestId = message.requestId;
  try {
    const useKoreanModel = Array.isArray(message.languages) && message.languages.includes("kor");
    const recognizerConfig = useKoreanModel ? RECOGNIZER_CONFIGS.korean : RECOGNIZER_CONFIGS.ch;

    reportProgress("Loading PP-OCRv5 models", 0.05);
    const [detector, recognizer, characters] = await Promise.all([
      getDetectorSession(),
      getRecognizerSession(useKoreanModel ? "korean" : "ch", recognizerConfig),
      getCharacterList(useKoreanModel ? "korean" : "ch", recognizerConfig.dictionary)
    ]);

    const imageSize = await getImageSize(message.imageDataUrl);
    const scaleX = imageSize.width / message.viewport.width;
    const scaleY = imageSize.height / message.viewport.height;
    const rectangle = {
      left: Math.max(0, Math.round(message.rectangle.left * scaleX)),
      top: Math.max(0, Math.round(message.rectangle.top * scaleY)),
      width: Math.max(1, Math.round(message.rectangle.width * scaleX)),
      height: Math.max(1, Math.round(message.rectangle.height * scaleY))
    };

    const preparedImageDataUrl = await prepareImageForOcr(message.imageDataUrl, rectangle);
    const preparedImage = await loadImage(preparedImageDataUrl);
    reportProgress("Detecting text", 0.35);
    const detectorInput = await createDetectorInput(preparedImage);
    const detectorResult = await detector.run({
      [detector.inputNames[0]]: detectorInput.tensor
    });
    const detectorOutput = detectorResult[detector.outputNames[0]];
    const textLines = findTextLines(
      detectorOutput,
      preparedImage.naturalWidth,
      preparedImage.naturalHeight
    );

    if (textLines.length === 0) {
      sendResult(message.requestId, { text: "" });
      return;
    }

    const recognizedLines = [];
    for (let index = 0; index < textLines.length; index += 1) {
      const text = await recognizeLine(
        recognizer,
        preparedImage,
        textLines[index],
        characters
      );
      if (text) recognizedLines.push(text);
      if (index === textLines.length - 1 || index % 3 === 0) {
        reportProgress("Recognizing text", 0.45 + 0.5 * ((index + 1) / textLines.length));
      }
    }

    sendResult(message.requestId, { text: cleanRecognizedText(recognizedLines.join("\n")) });
  } finally {
    if (activeRequestId === message.requestId) activeRequestId = null;
  }
}

function configureRuntime() {
  if (runtimeConfigured) return;
  if (!globalThis.ort) throw new Error("ONNX Runtime Web failed to load.");
  ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/onnxruntime/");
  ort.env.wasm.numThreads = 1;
  runtimeConfigured = true;
}

function getDetectorSession() {
  configureRuntime();
  if (!detectorSessionPromise) {
    detectorSessionPromise = createSession(DETECTOR_MODEL_URL).catch((error) => {
      detectorSessionPromise = null;
      throw error;
    });
  }
  return detectorSessionPromise;
}

function getRecognizerSession(key, config) {
  configureRuntime();
  if (!recognizerSessionPromises.has(key)) {
    const sessionPromise = createSession(config.model).catch((error) => {
      recognizerSessionPromises.delete(key);
      throw error;
    });
    recognizerSessionPromises.set(key, sessionPromise);
  }
  return recognizerSessionPromises.get(key);
}

function createSession(modelUrl) {
  return ort.InferenceSession.create(modelUrl, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all"
  });
}

function getCharacterList(key, dictionaryUrl) {
  if (!characterListPromises.has(key)) {
    const listPromise = fetch(dictionaryUrl)
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load the OCR character dictionary.");
        return response.text();
      })
      .then((text) => {
        const entries = text.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
        if (entries[entries.length - 1] === "") entries.pop();
        return [null, ...entries, " "];
      })
      .catch((error) => {
        characterListPromises.delete(key);
        throw error;
      });
    characterListPromises.set(key, listPromise);
  }
  return characterListPromises.get(key);
}

function reportProgress(status, progress) {
  if (!activeRequestId) return;
  chrome.runtime.sendMessage({
    target: "background",
    action: "ocr-progress",
    requestId: activeRequestId,
    status,
    progress
  }).catch(() => {});
}

function getImageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Unable to read the captured image."));
    image.src = dataUrl;
  });
}

async function prepareImageForOcr(dataUrl, rectangle) {
  const image = await loadImage(dataUrl);
  const crop = clampRectangle(rectangle, image.naturalWidth, image.naturalHeight);
  const scale = chooseOcrScale(crop.width, crop.height);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return dataUrl;
  const resizedWidth = Math.round(crop.width * scale);
  const resizedHeight = Math.round(crop.height * scale);
  canvas.width = resizedWidth + OCR_PADDING * 2;
  canvas.height = resizedHeight + OCR_PADDING * 2;

  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    crop.left,
    crop.top,
    crop.width,
    crop.height,
    OCR_PADDING,
    OCR_PADDING,
    resizedWidth,
    resizedHeight
  );

  enhanceForOcr(context, {
    left: OCR_PADDING,
    top: OCR_PADDING,
    width: resizedWidth,
    height: resizedHeight
  });
  return canvas.toDataURL("image/png");
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to read the captured image."));
    image.src = dataUrl;
  });
}

function clampRectangle(rectangle, imageWidth, imageHeight) {
  const left = Math.min(Math.max(0, rectangle.left), imageWidth - 1);
  const top = Math.min(Math.max(0, rectangle.top), imageHeight - 1);
  return {
    left,
    top,
    width: Math.max(1, Math.min(rectangle.width, imageWidth - left)),
    height: Math.max(1, Math.min(rectangle.height, imageHeight - top))
  };
}

function chooseOcrScale(width, height) {
  const largestSide = Math.max(width, height);
  const fitSmallText = largestSide < OCR_MIN_SIDE ? OCR_MIN_SIDE / largestSide : OCR_SCALE;
  const fitMemory = OCR_MAX_SIDE / largestSide;
  return Math.max(1, Math.min(OCR_SCALE, fitSmallText, fitMemory));
}

function enhanceForOcr(context, bounds) {
  const imageData = context.getImageData(bounds.left, bounds.top, bounds.width, bounds.height);
  const data = imageData.data;
  const histogram = new Array(256).fill(0);
  let total = 0;
  let pixels = 0;

  for (let i = 0; i < data.length; i += 4) {
    const value = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    histogram[value] += 1;
    total += value;
    pixels += 1;
  }

  const average = total / pixels;
  const low = percentileFromHistogram(histogram, pixels, 0.03);
  const high = percentileFromHistogram(histogram, pixels, 0.97);
  const invert = average < 115;
  const adjustedLow = invert ? 255 - high : low;
  const adjustedHigh = invert ? 255 - low : high;
  const range = Math.max(24, adjustedHigh - adjustedLow);

  for (let index = 0; index < data.length; index += 4) {
    let value = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
    if (invert) value = 255 - value;
    value = Math.round(((value - adjustedLow) / range) * 255);
    value = Math.max(0, Math.min(255, value));
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }

  context.putImageData(imageData, bounds.left, bounds.top);
}

function percentileFromHistogram(histogram, totalPixels, percentile) {
  const target = totalPixels * percentile;
  let count = 0;
  for (let value = 0; value < histogram.length; value += 1) {
    count += histogram[value];
    if (count >= target) return value;
  }
  return histogram.length - 1;
}

async function createDetectorInput(image) {
  const originalWidth = image.naturalWidth;
  const originalHeight = image.naturalHeight;
  const scale = Math.min(1, DETECTOR_MAX_SIDE / Math.max(originalWidth, originalHeight));
  const width = Math.max(32, Math.round((originalWidth * scale) / 32) * 32);
  const height = Math.max(32, Math.round((originalHeight * scale) / 32) * 32);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Unable to prepare the image for OCR.");
  canvas.width = width;
  canvas.height = height;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);

  const pixels = context.getImageData(0, 0, width, height).data;
  const planeSize = width * height;
  const tensorData = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    const source = pixel * 4;
    const gray = (pixels[source] * 0.299 + pixels[source + 1] * 0.587 + pixels[source + 2] * 0.114) / 255;
    const normalized = gray * 2 - 1;
    tensorData[pixel] = normalized;
    tensorData[planeSize + pixel] = normalized;
    tensorData[planeSize * 2 + pixel] = normalized;
  }

  return {
    tensor: new ort.Tensor("float32", tensorData, [1, 3, height, width]),
    resizedWidth: width,
    resizedHeight: height
  };
}

function findTextLines(output, imageWidth, imageHeight) {
  const dimensions = output.dims;
  const mapHeight = Number(dimensions[dimensions.length - 2]);
  const mapWidth = Number(dimensions[dimensions.length - 1]);
  const scores = output.data;
  const pixelCount = mapWidth * mapHeight;
  const binary = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    if (scores[index] > DETECTOR_THRESHOLD) binary[index] = 1;
  }

  const dilated = new Uint8Array(pixelCount);
  for (let y = 0; y < mapHeight; y += 1) {
    const rowOffset = y * mapWidth;
    for (let x = 0; x < mapWidth; x += 1) {
      const index = rowOffset + x;
      if (!binary[index]) continue;
      dilated[index] = 1;
      if (x + 1 < mapWidth) dilated[index + 1] = 1;
      if (y + 1 < mapHeight) {
        dilated[index + mapWidth] = 1;
        if (x + 1 < mapWidth) dilated[index + mapWidth + 1] = 1;
      }
    }
  }

  const visited = new Uint8Array(pixelCount);
  const stack = new Int32Array(pixelCount);
  const scaleX = imageWidth / mapWidth;
  const scaleY = imageHeight / mapHeight;
  const boxes = [];

  for (let start = 0; start < pixelCount; start += 1) {
    if (!dilated[start] || visited[start]) continue;
    let stackSize = 1;
    stack[0] = start;
    visited[start] = 1;
    let minX = mapWidth;
    let minY = mapHeight;
    let maxX = -1;
    let maxY = -1;
    let area = 0;

    while (stackSize > 0) {
      const index = stack[--stackSize];
      const x = index % mapWidth;
      const y = Math.floor(index / mapWidth);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      area += 1;

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = y + offsetY;
        if (nextY < 0 || nextY >= mapHeight) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          if (nextX < 0 || nextX >= mapWidth) continue;
          const nextIndex = nextY * mapWidth + nextX;
          if (!dilated[nextIndex] || visited[nextIndex]) continue;
          visited[nextIndex] = 1;
          stack[stackSize++] = nextIndex;
        }
      }
    }

    if (area < 3 || maxX - minX < 1 || maxY - minY < 1) continue;
    const horizontalPadding = Math.max(2, Math.round(scaleX * 1.5));
    const verticalPadding = Math.max(2, Math.round(scaleY * 1.5));
    const left = Math.max(0, Math.floor(minX * scaleX) - horizontalPadding);
    const top = Math.max(0, Math.floor(minY * scaleY) - verticalPadding);
    const right = Math.min(imageWidth, Math.ceil((maxX + 1) * scaleX) + horizontalPadding);
    const bottom = Math.min(imageHeight, Math.ceil((maxY + 1) * scaleY) + verticalPadding);
    boxes.push({ left, top, right, bottom, width: right - left, height: bottom - top });
  }

  return groupBoxesIntoLines(boxes);
}

function groupBoxesIntoLines(boxes) {
  boxes.sort((first, second) => first.top - second.top || first.left - second.left);
  const lines = [];

  for (const box of boxes) {
    let bestLine = null;
    let bestMatch = 0;
    const boxCenter = (box.top + box.bottom) / 2;
    for (const line of lines) {
      const overlap = Math.max(0, Math.min(box.bottom, line.bottom) - Math.max(box.top, line.top));
      const minHeight = Math.max(1, Math.min(box.height, line.bottom - line.top));
      const overlapRatio = overlap / minHeight;
      const centerGap = Math.abs(boxCenter - (line.top + line.bottom) / 2);
      const centerMatch = centerGap <= Math.min(box.height, line.bottom - line.top) * 0.3;
      const match = Math.max(overlapRatio, centerMatch ? 0.36 : 0);
      if (match >= 0.35 && match > bestMatch) {
        bestMatch = match;
        bestLine = line;
      }
    }

    if (!bestLine) {
      lines.push({ ...box });
      continue;
    }
    bestLine.left = Math.min(bestLine.left, box.left);
    bestLine.top = Math.min(bestLine.top, box.top);
    bestLine.right = Math.max(bestLine.right, box.right);
    bestLine.bottom = Math.max(bestLine.bottom, box.bottom);
    bestLine.width = bestLine.right - bestLine.left;
    bestLine.height = bestLine.bottom - bestLine.top;
  }

  return lines
    .sort((first, second) => first.top - second.top || first.left - second.left)
    .slice(0, 200);
}

async function recognizeLine(session, image, line, characters) {
  const crop = clampRectangle(line, image.naturalWidth, image.naturalHeight);
  const scale = Math.min(
    RECOGNIZER_HEIGHT / crop.height,
    RECOGNIZER_MAX_WIDTH / crop.width
  );
  const resizedWidth = Math.max(1, Math.min(RECOGNIZER_MAX_WIDTH, Math.ceil(crop.width * scale)));
  const resizedHeight = Math.max(1, Math.min(RECOGNIZER_HEIGHT, Math.ceil(crop.height * scale)));
  const inputWidth = Math.max(
    RECOGNIZER_MIN_WIDTH,
    Math.min(RECOGNIZER_MAX_WIDTH, Math.ceil(resizedWidth / 32) * 32)
  );
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return "";
  canvas.width = inputWidth;
  canvas.height = RECOGNIZER_HEIGHT;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, inputWidth, RECOGNIZER_HEIGHT);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    crop.left,
    crop.top,
    crop.width,
    crop.height,
    0,
    0,
    resizedWidth,
    resizedHeight
  );

  const pixels = context.getImageData(0, 0, inputWidth, RECOGNIZER_HEIGHT).data;
  const planeSize = inputWidth * RECOGNIZER_HEIGHT;
  const tensorData = new Float32Array(planeSize * 3);
  for (let pixel = 0; pixel < planeSize; pixel += 1) {
    const source = pixel * 4;
    const gray = (pixels[source] * 0.299 + pixels[source + 1] * 0.587 + pixels[source + 2] * 0.114) / 255;
    const normalized = gray * 2 - 1;
    tensorData[pixel] = normalized;
    tensorData[planeSize + pixel] = normalized;
    tensorData[planeSize * 2 + pixel] = normalized;
  }

  const result = await session.run({
    [session.inputNames[0]]: new ort.Tensor("float32", tensorData, [1, 3, RECOGNIZER_HEIGHT, inputWidth])
  });
  const output = result[session.outputNames[0]];
  const dimensions = output.dims;
  const timeSteps = Number(dimensions[dimensions.length - 2]);
  const classCount = Number(dimensions[dimensions.length - 1]);
  let previousClass = -1;
  let text = "";

  for (let time = 0; time < timeSteps; time += 1) {
    const offset = time * classCount;
    let bestClass = 0;
    let bestScore = -Infinity;
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      const score = output.data[offset + classIndex];
      if (score > bestScore) {
        bestScore = score;
        bestClass = classIndex;
      }
    }
    if (bestClass !== 0 && bestClass !== previousClass) {
      const character = characters[bestClass];
      if (character !== null && character !== undefined) text += character;
    }
    previousClass = bestClass;
  }

  return text.trim();
}

function cleanRecognizedText(text) {
  return (text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sendResult(requestId, result) {
  chrome.runtime.sendMessage({ target: "background", action: "ocr-result", requestId, ...result });
}