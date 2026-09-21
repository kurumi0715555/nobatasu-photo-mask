export {};

type MaskMode = 'mosaic' | 'solid';
type ZoomMode = 'fit' | '1' | '2';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface EditAction {
  rect: Rect;
  mode: MaskMode;
  strength: number;
}

interface PointerDrag {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface Elements {
  fileInput: HTMLInputElement;
  chooseBtn: HTMLButtonElement;
  sampleBtn: HTMLButtonElement;
  dropZone: HTMLDivElement;
  status: HTMLElement;
  errorMessage: HTMLElement;
  editor: HTMLElement;
  imageInfo: HTMLElement;
  canvasViewport: HTMLDivElement;
  canvasStage: HTMLDivElement;
  imageCanvas: HTMLCanvasElement;
  selectionBox: HTMLDivElement;
  modeMosaic: HTMLButtonElement;
  modeSolid: HTMLButtonElement;
  strength: HTMLInputElement;
  strengthValue: HTMLOutputElement;
  undoBtn: HTMLButtonElement;
  redoBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  editCount: HTMLElement;
  zoom: HTMLSelectElement;
  coordinateForm: HTMLFormElement;
  rectX: HTMLInputElement;
  rectY: HTMLInputElement;
  rectW: HTMLInputElement;
  rectH: HTMLInputElement;
  applyRectBtn: HTMLButtonElement;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const MAX_EDGE = 8192;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MOSAIC_MIN = 8;
const MOSAIC_MAX = 64;

function getElement<T extends HTMLElement>(id: string, constructor: { new(): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) throw new Error(`Required element was not found: #${id}`);
  return element;
}

const elements: Elements = {
  fileInput: getElement('fileInput', HTMLInputElement),
  chooseBtn: getElement('chooseBtn', HTMLButtonElement),
  sampleBtn: getElement('sampleBtn', HTMLButtonElement),
  dropZone: getElement('dropZone', HTMLDivElement),
  status: getElement('status', HTMLElement),
  errorMessage: getElement('errorMessage', HTMLElement),
  editor: getElement('editor', HTMLElement),
  imageInfo: getElement('imageInfo', HTMLElement),
  canvasViewport: getElement('canvasViewport', HTMLDivElement),
  canvasStage: getElement('canvasStage', HTMLDivElement),
  imageCanvas: getElement('imageCanvas', HTMLCanvasElement),
  selectionBox: getElement('selectionBox', HTMLDivElement),
  modeMosaic: getElement('modeMosaic', HTMLButtonElement),
  modeSolid: getElement('modeSolid', HTMLButtonElement),
  strength: getElement('strength', HTMLInputElement),
  strengthValue: getElement('strengthValue', HTMLOutputElement),
  undoBtn: getElement('undoBtn', HTMLButtonElement),
  redoBtn: getElement('redoBtn', HTMLButtonElement),
  resetBtn: getElement('resetBtn', HTMLButtonElement),
  saveBtn: getElement('saveBtn', HTMLButtonElement),
  editCount: getElement('editCount', HTMLElement),
  zoom: getElement('zoom', HTMLSelectElement),
  coordinateForm: getElement('coordinateForm', HTMLFormElement),
  rectX: getElement('rectX', HTMLInputElement),
  rectY: getElement('rectY', HTMLInputElement),
  rectW: getElement('rectW', HTMLInputElement),
  rectH: getElement('rectH', HTMLInputElement),
  applyRectBtn: getElement('applyRectBtn', HTMLButtonElement),
};

function getCanvasContext(canvas: HTMLCanvasElement, alpha = true): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha });
  if (!context) throw new Error('Canvas 2D context is not available');
  return context;
}

const outputContext = getCanvasContext(elements.imageCanvas);

const originalCanvas = document.createElement('canvas');
originalCanvas.width = 0;
originalCanvas.height = 0;
const originalContext = getCanvasContext(originalCanvas);
const mosaicCanvas = document.createElement('canvas');
const mosaicContext = getCanvasContext(mosaicCanvas, false);

let mode: MaskMode = 'mosaic';
let actions: EditAction[] = [];
let historyPosition = 0;
let drag: PointerDrag | null = null;
let loadSequence = 0;
let isSaving = false;

function hasImage(): boolean {
  return originalCanvas.width > 0 && originalCanvas.height > 0;
}

function showError(message: string): void {
  elements.errorMessage.textContent = message;
  elements.errorMessage.hidden = false;
}

function clearError(): void {
  elements.errorMessage.textContent = '';
  elements.errorMessage.hidden = true;
}

function setStatus(message: string): void {
  elements.status.textContent = message;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeStrength(): number {
  const parsed = Number.parseInt(elements.strength.value, 10);
  const value = clamp(Number.isFinite(parsed) ? parsed : 24, MOSAIC_MIN, MOSAIC_MAX);
  elements.strength.value = String(value);
  elements.strengthValue.value = `${value}px`;
  elements.strengthValue.textContent = `${value}px`;
  return value;
}

function updateControls(): void {
  const loaded = hasImage();
  elements.undoBtn.disabled = !loaded || historyPosition === 0;
  elements.redoBtn.disabled = !loaded || historyPosition === actions.length;
  elements.resetBtn.disabled = !loaded || historyPosition === 0;
  elements.saveBtn.disabled = !loaded || historyPosition === 0 || drag !== null || isSaving;
  elements.applyRectBtn.disabled = !loaded;
  elements.editCount.textContent = `${historyPosition}か所`;
}

function applyMosaic(rect: Rect, strength: number): void {
  const block = clamp(Math.round(strength), MOSAIC_MIN, MOSAIC_MAX);
  const smallWidth = Math.max(1, Math.ceil(rect.width / block));
  const smallHeight = Math.max(1, Math.ceil(rect.height / block));
  mosaicCanvas.width = smallWidth;
  mosaicCanvas.height = smallHeight;
  mosaicContext.imageSmoothingEnabled = true;
  mosaicContext.clearRect(0, 0, smallWidth, smallHeight);
  mosaicContext.drawImage(
    elements.imageCanvas,
    rect.x, rect.y, rect.width, rect.height,
    0, 0, smallWidth, smallHeight,
  );
  outputContext.save();
  outputContext.imageSmoothingEnabled = false;
  outputContext.drawImage(mosaicCanvas, 0, 0, smallWidth, smallHeight, rect.x, rect.y, rect.width, rect.height);
  outputContext.restore();
}

function render(): void {
  if (!hasImage()) return;
  outputContext.clearRect(0, 0, elements.imageCanvas.width, elements.imageCanvas.height);
  outputContext.imageSmoothingEnabled = true;
  outputContext.drawImage(originalCanvas, 0, 0);
  for (const action of actions.slice(0, historyPosition)) {
    if (action.mode === 'solid') {
      outputContext.fillStyle = '#000';
      outputContext.fillRect(action.rect.x, action.rect.y, action.rect.width, action.rect.height);
    } else {
      applyMosaic(action.rect, action.strength);
    }
  }
  updateControls();
}

function setMode(nextMode: MaskMode): void {
  mode = nextMode;
  elements.modeMosaic.setAttribute('aria-pressed', String(mode === 'mosaic'));
  elements.modeSolid.setAttribute('aria-pressed', String(mode === 'solid'));
  elements.strength.disabled = mode !== 'mosaic';
}

function currentDisplayScale(): number {
  if (!hasImage()) return 1;
  return elements.canvasStage.getBoundingClientRect().width / originalCanvas.width || 1;
}

function updateStageSize(): void {
  if (!hasImage()) return;
  cancelDrag();
  const zoom = elements.zoom.value as ZoomMode;
  const availableWidth = Math.max(1, elements.canvasViewport.clientWidth);
  const availableHeight = Number.parseFloat(getComputedStyle(elements.canvasViewport).maxHeight) || innerHeight;
  const scale = zoom === 'fit'
    ? Math.min(1, availableWidth / originalCanvas.width, (availableHeight - 2) / originalCanvas.height)
    : Number(zoom);
  elements.canvasStage.style.width = `${Math.round(originalCanvas.width * scale)}px`;
  elements.canvasStage.style.height = `${Math.round(originalCanvas.height * scale)}px`;
  elements.imageCanvas.style.width = '100%';
  elements.imageCanvas.style.height = '100%';
}

function setCoordinateLimits(): void {
  for (const input of [elements.rectX, elements.rectW]) input.max = String(originalCanvas.width);
  for (const input of [elements.rectY, elements.rectH]) input.max = String(originalCanvas.height);
}

function commitImage(source: CanvasImageSource, width: number, height: number, name: string): void {
  loadSequence += 1;
  originalCanvas.width = width;
  originalCanvas.height = height;
  originalContext.drawImage(source, 0, 0, width, height);
  elements.imageCanvas.width = width;
  elements.imageCanvas.height = height;
  actions = [];
  historyPosition = 0;
  drag = null;
  elements.editor.hidden = false;
  document.body.classList.add('has-image');
  elements.imageInfo.textContent = `${name}（${width} × ${height}px）`;
  setCoordinateLimits();
  clearError();
  updateStageSize();
  render();
  setStatus('画像を読み込みました');
}

function validateFile(file: File): string | null {
  if (!ALLOWED_TYPES.has(file.type.toLowerCase())) return 'JPEG・PNG・WebPの画像を選んでください。';
  if (file.size > MAX_FILE_BYTES) return '画像は25MB以下にしてください。';
  if (file.size === 0) return '空のファイルは読み込めません。';
  return null;
}

function confirmReplacement(): boolean {
  return historyPosition === 0 || window.confirm('編集中の内容を破棄して、別の画像を読み込みますか？');
}

async function loadFile(file: File): Promise<void> {
  const fileError = validateFile(file);
  if (fileError) {
    showError(fileError);
    return;
  }
  if (!confirmReplacement()) return;

  const request = ++loadSequence;
  clearError();
  setStatus('画像を確認しています…');
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    if (request !== loadSequence) return;
    const { width, height } = bitmap;
    if (width > MAX_EDGE || height > MAX_EDGE) {
      showError('画像の一辺は8192px以下にしてください。');
      setStatus('画像を読み込めませんでした');
      return;
    }
    if (width * height > MAX_PIXELS) {
      showError('画像は2000万画素以下にしてください。');
      setStatus('画像を読み込めませんでした');
      return;
    }
    commitImage(bitmap, width, height, file.name || '貼り付けた画像');
  } catch {
    if (request === loadSequence) {
      showError('画像を開けませんでした。壊れていないか確認してください。');
      setStatus('画像を読み込めませんでした');
    }
  } finally {
    bitmap?.close();
    elements.fileInput.value = '';
  }
}

function createSample(): void {
  if (!confirmReplacement()) return;
  const sample = document.createElement('canvas');
  sample.width = 1200;
  sample.height = 800;
  const context = sample.getContext('2d', { alpha: false });
  if (!context) return;
  const gradient = context.createLinearGradient(0, 0, 1200, 800);
  gradient.addColorStop(0, '#dbeafe');
  gradient.addColorStop(1, '#fef3c7');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1200, 800);
  context.fillStyle = '#fff';
  context.fillRect(55, 45, 1090, 115);
  context.fillStyle = '#1f2937';
  context.font = 'bold 44px sans-serif';
  context.fillText('1年2組　校外学習', 95, 115);
  const people = [
    { x: 230, y: 370, color: '#ef4444', label: '山田 花子' },
    { x: 600, y: 350, color: '#3b82f6', label: '佐藤 太郎' },
    { x: 970, y: 385, color: '#10b981', label: '鈴木 未来' },
  ];
  for (const person of people) {
    context.fillStyle = '#f2c7a5';
    context.beginPath();
    context.arc(person.x, person.y, 95, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#3f2d20';
    context.beginPath();
    context.arc(person.x, person.y - 25, 98, Math.PI, Math.PI * 2);
    context.fill();
    context.fillStyle = '#222';
    context.beginPath();
    context.arc(person.x - 32, person.y, 9, 0, Math.PI * 2);
    context.arc(person.x + 32, person.y, 9, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = person.color;
    context.fillRect(person.x - 120, person.y + 105, 240, 195);
    context.fillStyle = '#fff';
    context.fillRect(person.x - 105, person.y + 175, 210, 72);
    context.fillStyle = '#111827';
    context.font = 'bold 27px sans-serif';
    context.textAlign = 'center';
    context.fillText(person.label, person.x, person.y + 220);
  }
  context.textAlign = 'start';
  commitImage(sample, sample.width, sample.height, '練習用サンプル');
}

function displayPoint(event: PointerEvent): { x: number; y: number } {
  const bounds = elements.canvasStage.getBoundingClientRect();
  return {
    x: clamp(event.clientX - bounds.left, 0, bounds.width),
    y: clamp(event.clientY - bounds.top, 0, bounds.height),
  };
}

function dragDisplayRect(): Rect | null {
  if (!drag) return null;
  return {
    x: Math.min(drag.startX, drag.currentX),
    y: Math.min(drag.startY, drag.currentY),
    width: Math.abs(drag.currentX - drag.startX),
    height: Math.abs(drag.currentY - drag.startY),
  };
}

function showSelection(): void {
  const rect = dragDisplayRect();
  if (!rect) return;
  elements.selectionBox.hidden = false;
  elements.selectionBox.style.left = `${rect.x}px`;
  elements.selectionBox.style.top = `${rect.y}px`;
  elements.selectionBox.style.width = `${rect.width}px`;
  elements.selectionBox.style.height = `${rect.height}px`;
}

function cancelDrag(): void {
  drag = null;
  elements.selectionBox.hidden = true;
  updateControls();
}

function addAction(rect: Rect): void {
  loadSequence += 1;
  const x = clamp(Math.round(rect.x), 0, originalCanvas.width - 1);
  const y = clamp(Math.round(rect.y), 0, originalCanvas.height - 1);
  const width = clamp(Math.round(rect.width), 1, originalCanvas.width - x);
  const height = clamp(Math.round(rect.height), 1, originalCanvas.height - y);
  actions = actions.slice(0, historyPosition);
  actions.push({ rect: { x, y, width, height }, mode, strength: normalizeStrength() });
  historyPosition = actions.length;
  render();
  setStatus(mode === 'mosaic' ? 'モザイクをかけました' : '黒く隠しました');
}

function finishDrag(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const point = displayPoint(event);
  drag.currentX = point.x;
  drag.currentY = point.y;
  const displayRect = dragDisplayRect();
  const scale = currentDisplayScale();
  cancelDrag();
  if (elements.canvasStage.hasPointerCapture(event.pointerId)) {
    elements.canvasStage.releasePointerCapture(event.pointerId);
  }
  if (!displayRect || displayRect.width < 2 || displayRect.height < 2) {
    setStatus('範囲をドラッグしてください');
    return;
  }
  addAction({
    x: displayRect.x / scale,
    y: displayRect.y / scale,
    width: displayRect.width / scale,
    height: displayRect.height / scale,
  });
}

function undo(): void {
  if (historyPosition === 0) return;
  loadSequence += 1;
  historyPosition -= 1;
  render();
  setStatus('1つ戻しました');
}

function redo(): void {
  if (historyPosition >= actions.length) return;
  loadSequence += 1;
  historyPosition += 1;
  render();
  setStatus('1つやり直しました');
}

function resetEdits(): void {
  if (historyPosition === 0 || !window.confirm('すべての目かくしを解除しますか？')) return;
  loadSequence += 1;
  actions = [];
  historyPosition = 0;
  cancelDrag();
  render();
  setStatus('すべて解除しました');
}

function parseCoordinate(input: HTMLInputElement): number {
  return Number(input.value);
}

function applyCoordinateRect(event: SubmitEvent): void {
  event.preventDefault();
  if (!hasImage()) return;
  const rect: Rect = {
    x: parseCoordinate(elements.rectX),
    y: parseCoordinate(elements.rectY),
    width: parseCoordinate(elements.rectW),
    height: parseCoordinate(elements.rectH),
  };
  if (!Object.values(rect).every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) {
    showError('位置と大きさを0以上の数値で入力してください。');
    return;
  }
  if (rect.x >= originalCanvas.width || rect.y >= originalCanvas.height
      || rect.x + rect.width > originalCanvas.width || rect.y + rect.height > originalCanvas.height) {
    showError('範囲が画像からはみ出しています。');
    return;
  }
  clearError();
  addAction(rect);
}

function saveImage(): void {
  if (!hasImage() || historyPosition === 0 || drag || isSaving) return;
  isSaving = true;
  updateControls();
  setStatus('PNGを準備しています…');
  elements.imageCanvas.toBlob((blob) => {
    isSaving = false;
    updateControls();
    if (!blob) {
      showError('PNGを作成できませんでした。もう一度お試しください。');
      setStatus('保存できませんでした');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'photo-masked.png';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('PNGのダウンロードを開始しました');
  }, 'image/png');
}

elements.chooseBtn.addEventListener('click', () => elements.fileInput.click());
elements.fileInput.addEventListener('change', () => {
  const file = elements.fileInput.files?.[0];
  elements.fileInput.value = '';
  if (file) void loadFile(file);
});
elements.sampleBtn.addEventListener('click', createSample);
elements.dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
elements.dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (file) void loadFile(file);
});
document.addEventListener('paste', (event) => {
  const file = event.clipboardData?.files[0];
  if (file) {
    event.preventDefault();
    void loadFile(file);
  }
});

elements.canvasStage.addEventListener('pointerdown', (event) => {
  if (!hasImage() || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
  const point = displayPoint(event);
  drag = { pointerId: event.pointerId, startX: point.x, startY: point.y, currentX: point.x, currentY: point.y };
  elements.canvasStage.setPointerCapture(event.pointerId);
  showSelection();
  updateControls();
  event.preventDefault();
});
elements.canvasStage.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const point = displayPoint(event);
  drag.currentX = point.x;
  drag.currentY = point.y;
  showSelection();
});
elements.canvasStage.addEventListener('pointerup', finishDrag);
elements.canvasStage.addEventListener('pointercancel', cancelDrag);
elements.canvasStage.addEventListener('lostpointercapture', cancelDrag);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && drag) {
    cancelDrag();
    setStatus('範囲選択を中止しました');
  }
});

elements.modeMosaic.addEventListener('click', () => setMode('mosaic'));
elements.modeSolid.addEventListener('click', () => setMode('solid'));
elements.strength.addEventListener('input', normalizeStrength);
elements.undoBtn.addEventListener('click', undo);
elements.redoBtn.addEventListener('click', redo);
elements.resetBtn.addEventListener('click', resetEdits);
elements.saveBtn.addEventListener('click', saveImage);
elements.zoom.addEventListener('change', updateStageSize);
elements.coordinateForm.addEventListener('submit', applyCoordinateRect);

new ResizeObserver(() => {
  if (elements.zoom.value === 'fit') updateStageSize();
}).observe(elements.canvasViewport);

setMode('mosaic');
normalizeStrength();
updateControls();
