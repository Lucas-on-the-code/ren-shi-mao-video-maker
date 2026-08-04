"use strict";

const els = {
  canvas: document.getElementById("stage"),
  midiFile: document.getElementById("midiFile"),
  tracks: document.getElementById("tracks"),
  status: document.getElementById("status"),
  playBtn: document.getElementById("playBtn"),
  stopBtn: document.getElementById("stopBtn"),
  renderBtn: document.getElementById("renderBtn"),
  layoutBtn: document.getElementById("layoutBtn"),
  seek: document.getElementById("seek"),
  timeText: document.getElementById("timeText"),
  videoWidth: document.getElementById("videoWidth"),
  videoHeight: document.getElementById("videoHeight"),
  fps: document.getElementById("fps"),
  volume: document.getElementById("volume"),
  backgroundFile: document.getElementById("backgroundFile"),
  transparentExport: document.getElementById("transparentExport"),
  defaultClosedImage: document.getElementById("defaultClosedImage"),
  defaultOpenImage: document.getElementById("defaultOpenImage"),
  defaultClosedSwatch: document.getElementById("defaultClosedSwatch"),
  defaultOpenSwatch: document.getElementById("defaultOpenSwatch"),
  lyricColor: document.getElementById("lyricColor"),
  lyricFont: document.getElementById("lyricFont"),
  lyricHeight: document.getElementById("lyricHeight"),
  downloadLink: document.getElementById("downloadLink"),
};

const ctx = els.canvas.getContext("2d");

let song = null;
let configs = [];
let playing = false;
let playStartedAt = 0;
let playOffset = 0;
let rafId = 0;
let audioContext = null;
let activeOscillators = [];
let backgroundImage = null;
let backgroundImageDataUrl = null;
let defaultClosedImage = null;
let defaultClosedImageDataUrl = null;
let defaultOpenImage = null;
let defaultOpenImageDataUrl = null;
let draggedTrackIndex = -1;
let restoring = false;

const CHARACTER_SIZE_RATIO = 0.3;
const LYRIC_FLOAT_DURATION = 0.7;
const LYRIC_HOLD_DURATION = 0;
const LYRIC_FADE_DURATION = 0.3;
const LYRIC_TOTAL_DURATION = LYRIC_FLOAT_DURATION + LYRIC_HOLD_DURATION + LYRIC_FADE_DURATION;
const STORE_NAME = "midi-character-video-state-v1";
const FILE_KEYS = ["midi", "background", "defaultClosed", "defaultOpen"];

const DEFAULT_COLORS = [
  "#49c5b6",
  "#f0c15f",
  "#ef7d57",
  "#8ab4f8",
  "#c58af9",
  "#7ad77a",
  "#f285ad",
  "#6fd0ff",
];

els.midiFile.addEventListener("change", loadMidi);
els.playBtn.addEventListener("click", playPreview);
els.stopBtn.addEventListener("click", stopPreview);
els.renderBtn.addEventListener("click", renderVideo);
els.layoutBtn.addEventListener("click", autoLayout);
els.backgroundFile.addEventListener("change", loadBackground);
els.defaultClosedImage.addEventListener("change", (event) => loadDefaultImage(event, "closedImage"));
els.defaultOpenImage.addEventListener("change", (event) => loadDefaultImage(event, "openImage"));
els.lyricColor.addEventListener("input", () => drawFrame(currentTime()));
els.lyricFont.addEventListener("change", () => drawFrame(currentTime()));
els.lyricHeight.addEventListener("input", () => drawFrame(currentTime()));
els.canvas.addEventListener("pointerdown", startDrag);
els.canvas.addEventListener("pointermove", dragCharacter);
els.canvas.addEventListener("pointerup", stopDrag);
els.canvas.addEventListener("pointercancel", stopDrag);
els.seek.addEventListener("input", () => {
  playOffset = Number(els.seek.value);
  drawFrame(playOffset);
  updateTime(playOffset);
});

for (const input of [els.videoWidth, els.videoHeight]) {
  input.addEventListener("change", resizeCanvas);
}

for (const input of [els.videoWidth, els.videoHeight, els.fps, els.volume, els.transparentExport, els.lyricColor, els.lyricFont, els.lyricHeight]) {
  input.addEventListener("input", saveState);
  input.addEventListener("change", saveState);
}

function resizeCanvas() {
  const width = clamp(Number(els.videoWidth.value) || 1280, 320, 3840);
  const height = clamp(Number(els.videoHeight.value) || 720, 240, 2160);
  els.canvas.width = width;
  els.canvas.height = height;
  els.canvas.style.aspectRatio = `${width} / ${height}`;
  els.canvas.style.setProperty("--aspect", String(width / height));
  syncPositionSliders();
  drawFrame(currentTime());
}

async function loadMidi() {
  const file = els.midiFile.files[0];
  if (!file) return;
  const buffer = await file.arrayBuffer();
  await loadMidiBuffer(buffer);
  if (!restoring) {
    await saveFile("midi", file);
    saveState();
  }
}

async function loadMidiBuffer(buffer) {
  try {
    const parsed = parseMidi(buffer);
    const tracks = parsed.tracks.filter((track) => track.notes.length > 0);
    const globalLyrics = parsed.tracks.flatMap((track) => (track.notes.length ? [] : track.lyrics));
    if (!tracks.length) {
      throw new Error("这个 MIDI 没有可用音符轨道。");
    }
    if (globalLyrics.length && !tracks.some((track) => track.lyrics.length)) {
      tracks[0] = { ...tracks[0], lyrics: globalLyrics.sort((a, b) => a.time - b.time) };
    }
    for (const track of tracks) {
      if (track.lyrics.length) {
        track.lyrics = lyricsFromNoteStarts(track.notes);
      }
    }

    song = {
      ...parsed,
      tracks,
      duration: Math.max(...tracks.flatMap((track) => track.notes.map((note) => note.end))) + 0.8,
    };
    configs = tracks.map((track, index) => makeConfig(track, index, tracks.length));
    els.seek.max = String(song.duration);
    els.seek.disabled = false;
    els.playBtn.disabled = false;
    els.stopBtn.disabled = false;
    els.renderBtn.disabled = false;
    els.layoutBtn.disabled = false;
    const lyricCount = tracks.reduce((count, track) => count + track.lyrics.length, 0);
    setStatus(`已载入 ${tracks.length} 个有音符的轨道，${lyricCount} 条歌词，时长 ${formatTime(song.duration)}。`);
    renderTrackControls();
    drawFrame(0);
    updateTime(0);
  } catch (error) {
    song = null;
    configs = [];
    els.tracks.innerHTML = "";
    els.playBtn.disabled = true;
    els.stopBtn.disabled = true;
    els.renderBtn.disabled = true;
    els.layoutBtn.disabled = true;
    els.seek.disabled = true;
    setStatus(error.message || "MIDI 解析失败。", true);
    drawEmpty();
  }
}

async function loadBackground() {
  const file = els.backgroundFile.files[0];
  backgroundImageDataUrl = file ? await fileToDataUrl(file) : null;
  backgroundImage = backgroundImageDataUrl ? await imageFromDataUrl(backgroundImageDataUrl) : null;
  if (file && !restoring) await saveFile("background", file);
  if (!restoring) saveState();
  drawFrame(currentTime());
}

async function loadDefaultImage(event, kind) {
  const file = event.currentTarget.files[0];
  if (!file) return;
  const dataUrl = await fileToDataUrl(file);
  const image = await imageFromDataUrl(dataUrl);
  if (kind === "closedImage") {
    defaultClosedImage = image;
    defaultClosedImageDataUrl = dataUrl;
    renderSwatch(els.defaultClosedSwatch, image);
    if (!restoring) await saveFile("defaultClosed", file);
  } else {
    defaultOpenImage = image;
    defaultOpenImageDataUrl = dataUrl;
    renderSwatch(els.defaultOpenSwatch, image);
    if (!restoring) await saveFile("defaultOpen", file);
  }
  refreshInheritedSwatches(kind);
  if (!restoring) saveState();
  drawFrame(currentTime());
}

function makeConfig(track, index, total) {
  const x = ((index + 1) / (total + 1)) * els.canvas.width;
  return {
    id: crypto.randomUUID(),
    name: track.name || `轨道 ${track.index + 1}`,
    x,
    y: els.canvas.height * 0.68,
    scale: 1,
    tilt: 10,
    color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
    closedImage: null,
    openImage: null,
  };
}


function renderTrackControls() {
  els.tracks.innerHTML = "";
  song.tracks.forEach((track, index) => {
    const config = configs[index];
    const card = document.createElement("article");
    card.className = "track";
    // 每个卡片独立维护展开状态
    const isExpanded = config._expanded == true; // 默认关闭

    // 将轨道内容分为头部和可折叠区域
    card.innerHTML = `
      <div class="track-header" data-track-index="${index}">
        <div class="track-head">
          <div class="track-name" title="${escapeHtml(config.name)}">${escapeHtml(config.name)}</div>
          <div class="track-notes">${track.notes.length} notes</div>
        </div>
        <button class="track-toggle" type="button" aria-expanded="${isExpanded}">
          ${isExpanded ? '▼' : '▶'}
        </button>
      </div>
      <div class="track-body" style="display: ${isExpanded ? 'block' : 'none'};">
        <div class="preview">
          <label>
            <span>闭嘴图</span>
            <input data-kind="closedImage" type="file" accept="image/*" />
            <div class="swatch" data-swatch="closedImage">未选择</div>
          </label>
          <label>
            <span>张嘴图</span>
            <input data-kind="openImage" type="file" accept="image/*" />
            <div class="swatch" data-swatch="openImage">未选择</div>
          </label>
        </div>
        <div class="grid">
          <label>
            <span>X 位置</span>
            <input data-kind="x" type="range" min="0" max="${els.canvas.width}" value="${config.x}" step="1" />
          </label>
          <label>
            <span>Y 位置</span>
            <input data-kind="y" type="range" min="0" max="${els.canvas.height}" value="${config.y}" step="1" />
          </label>
          <label>
            <span>缩放</span>
            <input data-kind="scale" type="range" min="0.1" max="5" value="${config.scale}" step="0.01" />
          </label>
          <label>
            <span>Tilt 上限</span>
            <input data-kind="tilt" type="range" min="0" max="28" value="${config.tilt}" step="1" />
          </label>
        </div>
      </div>
    `;

    // ---- 绑定折叠事件 ----
    const header = card.querySelector(".track-header");
    const body = card.querySelector(".track-body");
    const toggleBtn = card.querySelector(".track-toggle");

    function toggleExpand() {
      const isCurrentlyExpanded = body.style.display !== "none";
      const newExpanded = !isCurrentlyExpanded;
      body.style.display = newExpanded ? "block" : "none";
      toggleBtn.textContent = newExpanded ? "▼" : "▶";
      toggleBtn.setAttribute("aria-expanded", String(newExpanded));
      config._expanded = newExpanded; // 记住状态
      saveState(); // 保存状态到 localStorage
    }

    header.addEventListener("click", toggleExpand);

    // ---- 绑定输入控件 ----
    for (const input of card.querySelectorAll("input:not(.track-toggle)")) {
      input.addEventListener("input", (event) => updateConfig(event, index, card));
      input.addEventListener("change", (event) => updateConfig(event, index, card));
    }

    // ---- 恢复图片预览 ----
    for (const kind of ["closedImage", "openImage"]) {
      if (config[kind]) {
        const swatch = card.querySelector(`[data-swatch="${kind}"]`);
        renderSwatch(swatch, config[kind]);
      }
    }
    for (const kind of ["closedImage", "openImage"]) {
      if (config[kind]) continue;
      const inherited = imageForKind(kind);
      if (inherited) {
        const swatch = card.querySelector(`[data-swatch="${kind}"]`);
        renderSwatch(swatch, inherited, "默认");
      }
    }

    els.tracks.appendChild(card);
  });
}


async function updateConfig(event, index, card) {
  const input = event.currentTarget;
  const kind = input.dataset.kind;
  const config = configs[index];
  if (input.type === "file") {
    const file = input.files[0];
    if (!file) return;
    config[`${kind}DataUrl`] = await fileToDataUrl(file);
    config[kind] = await imageFromDataUrl(config[`${kind}DataUrl`]);
    await saveFile(`track-${index}-${kind}`, file);
    const swatch = card.querySelector(`[data-swatch="${kind}"]`);
    renderSwatch(swatch, config[kind]);
  } else {
    config[kind] = Number(input.value);
  }
  saveState();
  drawFrame(currentTime());
}

function renderSwatch(swatch, image, label = "") {
  swatch.innerHTML = "";
  const clone = image.cloneNode();
  clone.alt = label;
  swatch.appendChild(clone);
}

function refreshInheritedSwatches(kind) {
  for (const [index, config] of configs.entries()) {
    if (config[kind]) continue;
    const card = els.tracks.children[index];
    const swatch = card?.querySelector(`[data-swatch="${kind}"]`);
    const inherited = imageForKind(kind);
    if (swatch && inherited) renderSwatch(swatch, inherited, "默认");
  }
}

function imageForKind(kind) {
  return kind === "closedImage" ? defaultClosedImage : defaultOpenImage;
}

function autoLayout() {
  if (!song) return;
  configs.forEach((config, index) => {
    config.x = ((index + 1) / (configs.length + 1)) * els.canvas.width;
    config.y = els.canvas.height * 0.68;
  });
  renderTrackControls();
  saveState();
  drawFrame(currentTime());
}

function syncPositionSliders() {
  for (const input of els.tracks.querySelectorAll('[data-kind="x"]')) {
    input.max = String(els.canvas.width);
  }
  for (const input of els.tracks.querySelectorAll('[data-kind="y"]')) {
    input.max = String(els.canvas.height);
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`图片载入失败：${file.name}`));
    img.src = URL.createObjectURL(file);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function imageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function drawFrame(time, options = {}) {
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  drawBackground(options);

  if (!song) {
    if (!options.transparent) drawEmpty();
    return;
  }

  song.tracks.forEach((track, index) => {
    const config = configs[index];
    const active = activeNotes(track, time);
    const note = active.length ? active.reduce((highest, current) => (current.pitch > highest.pitch ? current : highest)) : null;
    drawCharacter(config, note, time, index);
  });
}

function drawBackground(options = {}) {
  if (options.transparent) return;
  const w = els.canvas.width;
  const h = els.canvas.height;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  if (backgroundImage) {
    drawCoverImage(backgroundImage, 0, 0, w, h);
  }
}

function drawCoverImage(image, x, y, width, height) {
  const imageRatio = image.width / image.height;
  const targetRatio = width / height;
  let sourceWidth = image.width;
  let sourceHeight = image.height;
  let sourceX = 0;
  let sourceY = 0;

  if (imageRatio > targetRatio) {
    sourceWidth = image.height * targetRatio;
    sourceX = (image.width - sourceWidth) / 2;
  } else {
    sourceHeight = image.width / targetRatio;
    sourceY = (image.height - sourceHeight) / 2;
  }

  ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

function drawEmpty() {
  drawBackground();
  ctx.fillStyle = "#27313a";
  ctx.font = "700 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("选择 MIDI 后开始配置轨道人物", els.canvas.width / 2, els.canvas.height / 2);
}

function drawCharacter(config, note, time, index) {
  const mouthOpen = isMouthOpen(song && song.tracks[index], note, time);
  const image = mouthOpen ? config.openImage || defaultOpenImage : config.closedImage || defaultClosedImage;
  const baseSize = Math.min(els.canvas.width, els.canvas.height) * CHARACTER_SIZE_RATIO * config.scale;
  const { pitchStretch, tilt } = characterDynamics(song && song.tracks[index], time, index, config.tilt);

  ctx.save();
  ctx.translate(config.x, config.y);
  ctx.transform(1, 0, Math.tan((tilt * Math.PI) / 180), 1, 0, 0);
  ctx.scale(1, pitchStretch);

  if (image) {
    const ratio = image.width / image.height || 1;
    const height = baseSize;
    const width = height * ratio;
    ctx.drawImage(image, -width / 2, -height, width, height);
  } else {
    drawPlaceholder(config, mouthOpen, baseSize);
  }
  ctx.restore();
}

// Force a 2-frame closed mouth at the start of any note that follows another with no
// real gap (consecutive/legato notes), so runs re-articulate instead of holding open.
function isMouthOpen(track, note, time) {
  if (!note || !track) return false;
  const fps = clamp(Number(els.fps.value) || 60, 12, 60);
  const gapTol = 1 / fps;
  const reart = track.notes.some((n) => n.start < note.start && n.end >= note.start - gapTol);
  if (reart && (time - note.start) < 2 / fps) return false;
  return true;
}

function drawPlaceholder(config, isOpen, size) {
  ctx.fillStyle = config.color;
  ctx.beginPath();
  ctx.roundRect(-size * 0.38, -size, size * 0.76, size, size * 0.16);
  ctx.fill();
  ctx.fillStyle = "#171b1f";
  ctx.beginPath();
  ctx.arc(-size * 0.16, -size * 0.64, size * 0.045, 0, Math.PI * 2);
  ctx.arc(size * 0.16, -size * 0.64, size * 0.045, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#171b1f";
  ctx.lineWidth = Math.max(3, size * 0.035);
  ctx.beginPath();
  if (isOpen) {
    ctx.ellipse(0, -size * 0.42, size * 0.12, size * 0.18, 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(-size * 0.14, -size * 0.42);
    ctx.lineTo(size * 0.14, -size * 0.42);
  }
  ctx.stroke();
}

function drawLyric(config, track, time) {
  const lyric = currentLyric(track, time);
  if (!lyric) return;

  const age = time - lyric.time;
  const floatProgress = clamp(age / LYRIC_FLOAT_DURATION, 0, 1);
  const eased = 1 - (1 - floatProgress) ** 3;
  const fadeStart = LYRIC_FLOAT_DURATION + LYRIC_HOLD_DURATION;
  const alpha = age <= fadeStart ? 1 : 1 - clamp((age - fadeStart) / LYRIC_FADE_DURATION, 0, 1);
  if (alpha <= 0) return;

  const size = Math.min(els.canvas.width, els.canvas.height) * CHARACTER_SIZE_RATIO * config.scale;
  const x = clamp(config.x, 18, els.canvas.width - 18);
  const y = Math.max(32, config.y - size - 28 - Number(els.lyricHeight.value) - eased * 120);
  const fontSize = clamp(size * 0.22, 18, 96);
  const maxWidth = Math.max(120, Math.min(els.canvas.width * 0.42, size * 2.8));
  const lyricFont = `700 ${fontSize}px ${els.lyricFont.value}`;
  const lines = wrapText(lyric.text, maxWidth, lyricFont);
  const lineHeight = fontSize * 1.22;
  const textY = y - lines.length * lineHeight;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = els.lyricColor.value;
  ctx.font = lyricFont;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, index) => {
    ctx.fillText(line, x, textY + lineHeight * index + lineHeight / 2);
  });
  ctx.restore();
}

function currentLyric(track, time) {
  if (!track.lyrics?.length) return null;
  let lyric = null;
  for (const candidate of track.lyrics) {
    if (candidate.time <= time) lyric = candidate;
    else break;
  }
  if (!lyric || time - lyric.time > LYRIC_TOTAL_DURATION) return null;
  return lyric;
}

function wrapText(text, maxWidth, font) {
  ctx.save();
  ctx.font = font;
  const chars = Array.from(text);
  const lines = [];
  let line = "";
  for (const char of chars) {
    const next = line + char;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = char.trimStart();
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  ctx.restore();
  return lines.slice(0, 3);
}

function measureText(text) {
  return ctx.measureText(text).width;
}

function activeNotes(track, time) {
  return track.notes.filter((note) => note.start <= time && note.end > time);
}

function seededTilt(time, index, pitch, maxTilt) {
  const bucket = Math.floor(time * 8);
  const seed = Math.sin((bucket + 1) * 9898.233 + index * 313.7 + pitch * 19.19) * 43758.5453;
  return (seed - Math.floor(seed) - 0.5) * 2 * maxTilt;
}

// Easing for the tilt/height transitions (must stay identical to NativeRenderer).
const DYNAMICS_ATTACK = 0.05;  // seconds to ease in when a note starts (faster upward stretch)
const DYNAMICS_RELEASE = 0.18; // seconds to ease out after a note ends

function smoothstep01(x) {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

// Continuous tilt direction in [-1, 1]: the old per-1/8s random value, interpolated
// across each bucket with smoothstep so the tilt eases instead of snapping.
function tiltDirection(time, index, pitch) {
  const dir = (bucket) => {
    const seed = Math.sin((bucket + 1) * 9898.233 + index * 313.7 + pitch * 19.19) * 43758.5453;
    return (seed - Math.floor(seed) - 0.5) * 2;
  };
  const f = time * 8;
  const b = Math.floor(f);
  return dir(b) + (dir(b + 1) - dir(b)) * smoothstep01(f - b);
}

// Eased height (pitchStretch) and tilt. Attack when a note starts, release after it ends.
function characterDynamics(track, time, index, maxTilt) {
  const attack = DYNAMICS_ATTACK;
  const release = DYNAMICS_RELEASE;
  const targetStretch = (pitch) => 1 + clamp((pitch - 55) / 24, -1, 1) * 0.2; // 55 = G3 base pitch

  // Deviation (pitchStretch - 1) and tilt left by a note's release tail at `time`.
  const releaseDevTilt = (note) => {
    if (!note) return { dev: 0, tilt: 0 };
    const relProg = (time - note.end) / release;
    if (relProg < 0 || relProg >= 1) return { dev: 0, tilt: 0 };
    const attackAtEnd = smoothstep01((note.end - note.start) / attack);
    const env = attackAtEnd * (1 - smoothstep01(relProg));
    return {
      dev: (targetStretch(note.pitch) - 1) * env,
      tilt: tiltDirection(time, index, note.pitch) * maxTilt * env,
    };
  };

  if (!track) return { pitchStretch: 1, tilt: 0 };
  const active = track.notes.filter((n) => n.start <= time && n.end > time);
  if (active.length) {
    const note = active.reduce((h, c) => (c.pitch > h.pitch ? c : h));
    // Crossfade from the height/tilt the previous note still has at this moment into
    // this note's target, so a new note grows from the current height (no instant jump).
    const attackProg = smoothstep01((time - note.start) / attack);
    const targetDev = targetStretch(note.pitch) - 1;
    const targetTilt = tiltDirection(time, index, note.pitch) * maxTilt;
    const before = track.notes.filter((n) => n.end <= note.start);
    const prev = before.length ? before.reduce((a, b) => (b.end > a.end ? b : a)) : null;
    const residual = releaseDevTilt(prev);
    return {
      pitchStretch: 1 + residual.dev + (targetDev - residual.dev) * attackProg,
      tilt: residual.tilt + (targetTilt - residual.tilt) * attackProg,
    };
  }
  const ended = track.notes.filter((n) => n.end <= time && time < n.end + release);
  if (ended.length) {
    const note = ended.reduce((a, b) => (b.end > a.end ? b : a));
    const r = releaseDevTilt(note);
    return { pitchStretch: 1 + r.dev, tilt: r.tilt };
  }
  return { pitchStretch: 1, tilt: 0 };
}

function playPreview() {
  if (!song || playing) return;
  playing = true;
  playStartedAt = performance.now() / 1000 - playOffset;
  scheduleAudio(playOffset);
  tick();
}

function stopPreview() {
  playing = false;
  playOffset = currentTime();
  stopAudio();
  cancelAnimationFrame(rafId);
  drawFrame(playOffset);
  updateTime(playOffset);
}

function tick() {
  if (!playing || !song) return;
  const time = currentTime();
  if (time >= song.duration) {
    playOffset = 0;
    playing = false;
    stopAudio();
    drawFrame(0);
    updateTime(0);
    return;
  }
  drawFrame(time);
  els.seek.value = String(time);
  updateTime(time);
  rafId = requestAnimationFrame(tick);
}

function currentTime() {
  if (!playing) return playOffset;
  return performance.now() / 1000 - playStartedAt;
}

function updateTime(time) {
  const duration = song?.duration || 0;
  els.timeText.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
}

async function renderVideo() {
  if (!song) return;
  stopPreview();
  resizeCanvas();
  await renderVideoNative();
}

async function renderVideoNative() {
  if (location.protocol === "file:") {
    setStatus("请通过本地服务打开页面才能导出 MOV：node server.js", true);
    return;
  }
  els.renderBtn.disabled = true;
  try {
    setStatus("正在启动原生 GPU 渲染……");
    const payload = await buildRenderPayload();
    const startResponse = await fetch("/render-mov", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!startResponse.ok) throw new Error(await startResponse.text());
    const { id } = await startResponse.json();
    const output = await waitForRender(id);
    // The renderer already wrote the file to disk. ProRes 4K files are huge (often
    // many GB), so do NOT force a browser re-download into the Downloads folder —
    // that is what triggered "无法写文件". Just surface the saved path + a manual link.
    els.downloadLink.href = output.url;
    els.downloadLink.download = output.filename;
    els.downloadLink.hidden = false;
    setStatus(`MOV 已生成并保存在本地：${output.path}（文件较大，已直接存盘，无需重复下载）`);
  } catch (error) {
    setStatus(error.message || "MOV 导出失败。", true);
  } finally {
    els.renderBtn.disabled = false;
  }
}

async function renderVideoFromBrowserCanvas() {
  if (location.protocol === "file:") {
    setStatus("请通过本地服务打开页面才能导出 MOV：node server.js", true);
    return;
  }
  els.renderBtn.disabled = true;
  try {
    const transparent = els.transparentExport.checked;
    const fps = clamp(Number(els.fps.value) || 60, 12, 60);
    const startResponse = await fetch("/export-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fps, transparent }),
    });
    if (!startResponse.ok) throw new Error(await startResponse.text());
    const { id } = await startResponse.json();
    const totalFrames = Math.ceil(song.duration * fps);

    for (let frame = 0; frame < totalFrames; frame += 1) {
      const time = frame / fps;
      drawFrame(time, { transparent });
      els.seek.value = String(time);
      updateTime(time);
      const percent = Math.floor(((frame + 1) / totalFrames) * 100);
      setStatus(`所见即所得导出 MOV：${percent}%（${frame + 1} / ${totalFrames} 帧）`);
      const blob = await canvasToBlob("image/png");
      const upload = await fetch(`/export-frame?id=${encodeURIComponent(id)}&index=${frame}`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: blob,
      });
      if (!upload.ok) throw new Error(await upload.text());
      await nextPaint();
    }

    setStatus("正在合成 MOV，请保持页面打开。");
    const finishResponse = await fetch(`/export-finish?id=${encodeURIComponent(id)}`, { method: "POST" });
    if (!finishResponse.ok) throw new Error(await finishResponse.text());
    const output = await finishResponse.json();
    const link = document.createElement("a");
    link.href = output.url;
    link.download = output.filename;
    link.click();
    els.downloadLink.href = output.url;
    els.downloadLink.download = output.filename;
    els.downloadLink.hidden = false;
    setStatus(`MOV 已生成并保存在本地：${output.path}`);
  } catch (error) {
    setStatus(error.message || "MOV 导出失败。", true);
  } finally {
    els.renderBtn.disabled = false;
  }
}

function canvasToBlob(type, quality) {
  return new Promise((resolve, reject) => {
    els.canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("无法生成视频帧。"));
    }, type, quality);
  });
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function waitForRender(id) {
  while (true) {
    const response = await fetch(`/render-progress?id=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(await response.text());
    const progress = await response.json();
    if (progress.status === "done") return progress.output;
    if (progress.status === "error") throw new Error(progress.error || "MOV 导出失败。");
    const total = progress.totalFrames || 0;
    const frame = progress.frame || 0;
    const percent = total ? Math.floor((frame / total) * 100) : 0;
    setStatus(`本地渲染 MOV：${percent}%（${frame} / ${total} 帧）`);
    await delay(500);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildRenderPayload() {
  return {
    width: els.canvas.width,
    height: els.canvas.height,
    fps: clamp(Number(els.fps.value) || 60, 12, 60),
    duration: song.duration,
    transparent: els.transparentExport.checked,
    lyricColor: els.lyricColor.value,
    lyricFont: els.lyricFont.value,
    lyricHeight: Number(els.lyricHeight.value),
    tracks: song.tracks.map((track) => ({
      notes: track.notes,
      lyrics: track.lyrics,
    })),
    configs: configs.map((config) => ({
      x: config.x,
      y: config.y,
      scale: config.scale,
      tilt: config.tilt,
      color: config.color,
    })),
    images: {
      background: backgroundImageDataUrl,
      defaultClosed: defaultClosedImageDataUrl,
      defaultOpen: defaultOpenImageDataUrl,
      tracks: await Promise.all(configs.map(async (config) => ({
        closed: config.closedImageDataUrl || null,
        open: config.openImageDataUrl || null,
      }))),
    },
  };
}

function startDrag(event) {
  if (!song) return;
  const point = canvasPoint(event);
  draggedTrackIndex = hitTrack(point.x, point.y);
  if (draggedTrackIndex < 0) return;
  els.canvas.classList.add("dragging");
  els.canvas.setPointerCapture(event.pointerId);
}

function dragCharacter(event) {
  if (draggedTrackIndex < 0) return;
  const point = canvasPoint(event);
  const config = configs[draggedTrackIndex];
  config.x = clamp(point.x, 0, els.canvas.width);
  config.y = clamp(point.y, 0, els.canvas.height);
  syncTrackPositionInputs(draggedTrackIndex);
  drawFrame(currentTime());
}

function stopDrag(event) {
  if (draggedTrackIndex < 0) return;
  draggedTrackIndex = -1;
  els.canvas.classList.remove("dragging");
  if (els.canvas.hasPointerCapture(event.pointerId)) {
    els.canvas.releasePointerCapture(event.pointerId);
  }
}

function canvasPoint(event) {
  const rect = els.canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * els.canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * els.canvas.height,
  };
}

function hitTrack(x, y) {
  let bestIndex = -1;
  let bestDistance = Infinity;
  configs.forEach((config, index) => {
    const radius = Math.min(els.canvas.width, els.canvas.height) * CHARACTER_SIZE_RATIO * 0.75 * config.scale;
    const dx = x - config.x;
    const dy = y - (config.y - radius * 0.55);
    const distance = Math.hypot(dx, dy);
    if (distance <= radius && distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function syncTrackPositionInputs(index) {
  const card = els.tracks.children[index];
  if (!card) return;
  const config = configs[index];
  const xInput = card.querySelector('[data-kind="x"]');
  const yInput = card.querySelector('[data-kind="y"]');
  if (xInput) xInput.value = String(config.x);
  if (yInput) yInput.value = String(config.y);
  saveState();
}

async function saveFile(key, file) {
  await idbSet(key, { name: file.name, type: file.type, blob: file });
}

async function loadSavedFile(key) {
  const fromDb = await idbGet(key);
  if (fromDb) return fromDb;
  const raw = localStorage.getItem(`${STORE_NAME}:${key}`);
  if (!raw) return null;
  const legacy = JSON.parse(raw);
  const blob = await fetch(legacy.dataUrl).then((response) => response.blob());
  const saved = { name: legacy.name, type: legacy.type, blob };
  await idbSet(key, saved);
  localStorage.removeItem(`${STORE_NAME}:${key}`);
  return saved;
}

async function imageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      resolve(img);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function bufferFromBlob(blob) {
  return blob.arrayBuffer();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readonly");
    const request = tx.objectStore("files").get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

function saveState() {
  if (restoring) return;
  localStorage.setItem(
    STORE_NAME,
    JSON.stringify({
      videoWidth: els.videoWidth.value,
      videoHeight: els.videoHeight.value,
      fps: els.fps.value,
      volume: els.volume.value,
      transparentExport: els.transparentExport.checked,
      lyricColor: els.lyricColor.value,
      lyricFont: els.lyricFont.value,
      lyricHeight: els.lyricHeight.value,
      configs: configs.map((config) => ({
        x: config.x,
        y: config.y,
        scale: config.scale,
        tilt: config.tilt,
      })),
    }),
  );
}

async function restoreState() {
  restoring = true;
  try {
    const raw = localStorage.getItem(STORE_NAME);
    const state = raw ? JSON.parse(raw) : null;
    if (state) {
      els.videoWidth.value = state.videoWidth ?? els.videoWidth.value;
      els.videoHeight.value = state.videoHeight ?? els.videoHeight.value;
      els.fps.value = state.fps ?? els.fps.value;
      els.volume.value = state.volume ?? els.volume.value;
      els.transparentExport.checked = Boolean(state.transparentExport);
      els.lyricColor.value = state.lyricColor ?? els.lyricColor.value;
      els.lyricFont.value = state.lyricFont ?? els.lyricFont.value;
      els.lyricHeight.value = state.lyricHeight ?? els.lyricHeight.value;
    }
    resizeCanvas();

    const background = await loadSavedFile("background");
    if (background) {
      backgroundImageDataUrl = await blobToDataUrl(background.blob);
      backgroundImage = await imageFromDataUrl(backgroundImageDataUrl);
    }

    const defaultClosed = await loadSavedFile("defaultClosed");
    if (defaultClosed) {
      defaultClosedImageDataUrl = await blobToDataUrl(defaultClosed.blob);
      defaultClosedImage = await imageFromDataUrl(defaultClosedImageDataUrl);
      renderSwatch(els.defaultClosedSwatch, defaultClosedImage);
    }

    const defaultOpen = await loadSavedFile("defaultOpen");
    if (defaultOpen) {
      defaultOpenImageDataUrl = await blobToDataUrl(defaultOpen.blob);
      defaultOpenImage = await imageFromDataUrl(defaultOpenImageDataUrl);
      renderSwatch(els.defaultOpenSwatch, defaultOpenImage);
    }

    const midi = await loadSavedFile("midi");
    if (midi) {
      await loadMidiBuffer(await bufferFromBlob(midi.blob));
      if (state?.configs) {
        state.configs.forEach((saved, index) => {
          if (!configs[index]) return;
          Object.assign(configs[index], saved);
        });
      }
      for (const [index, config] of configs.entries()) {
        for (const kind of ["closedImage", "openImage"]) {
          const saved = await loadSavedFile(`track-${index}-${kind}`);
          if (saved) {
            config[`${kind}DataUrl`] = await blobToDataUrl(saved.blob);
            config[kind] = await imageFromDataUrl(config[`${kind}DataUrl`]);
          }
        }
      }
      renderTrackControls();
    }
    drawFrame(currentTime());
  } finally {
    restoring = false;
  }
}

function scheduleAudio(offset) {
  const graph = buildAudioGraph(offset);
  if (!graph) return;
  audioContext = graph.context;
  activeOscillators = graph.oscillators;
  graph.start();
}

function stopAudio() {
  for (const osc of activeOscillators) {
    try {
      osc.stop();
    } catch {
      // Already stopped.
    }
  }
  activeOscillators = [];
}

function buildAudioGraph(offset) {
  if (!song) return null;
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  const master = context.createGain();
  master.gain.value = Number(els.volume.value);
  master.connect(context.destination);
  master.connect(destination);

  const oscillators = [];
  const startAt = context.currentTime + 0.08;
  for (const track of song.tracks) {
    for (const note of track.notes) {
      if (note.end <= offset) continue;
      const osc = context.createOscillator();
      const gain = context.createGain();
      const noteStart = startAt + Math.max(0, note.start - offset);
      const noteEnd = startAt + note.end - offset;
      osc.type = "sine";
      osc.frequency.value = 440 * 2 ** ((note.pitch - 69) / 12);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.02, note.velocity * 0.13), noteStart + 0.02);
      gain.gain.setValueAtTime(Math.max(0.02, note.velocity * 0.13), Math.max(noteStart + 0.03, noteEnd - 0.04));
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      osc.connect(gain);
      gain.connect(master);
      osc.start(noteStart);
      osc.stop(noteEnd + 0.02);
      oscillators.push(osc);
    }
  }

  return {
    context,
    oscillators,
    destinationStream: destination.stream,
    start: () => context.resume(),
    stop: () => {
      for (const osc of oscillators) {
        try {
          osc.stop();
        } catch {
          // Already stopped.
        }
      }
      context.close();
    },
  };
}

function parseMidi(buffer) {
  const view = new DataView(buffer);
  let pos = 0;

  function readString(length) {
    let value = "";
    for (let i = 0; i < length; i += 1) value += String.fromCharCode(view.getUint8(pos++));
    return value;
  }

  function readUint16() {
    const value = view.getUint16(pos);
    pos += 2;
    return value;
  }

  function readUint32() {
    const value = view.getUint32(pos);
    pos += 4;
    return value;
  }

  if (readString(4) !== "MThd") throw new Error("不是有效的 MIDI 文件。");
  const headerLength = readUint32();
  const format = readUint16();
  const trackCount = readUint16();
  const division = readUint16();
  pos += headerLength - 6;
  if (division & 0x8000) throw new Error("暂不支持 SMPTE 时间格式的 MIDI。");

  const ticksPerBeat = division;
  const rawTracks = [];
  const tempos = [{ tick: 0, mpqn: 500000 }];

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    if (readString(4) !== "MTrk") throw new Error("MIDI 轨道块损坏。");
    const length = readUint32();
    const end = pos + length;
    const state = { tick: 0, runningStatus: 0, notes: [], lyrics: [], open: new Map(), name: "" };

    while (pos < end) {
      state.tick += readVarLen(view, () => pos++);
      let status = view.getUint8(pos++);
      if (status < 0x80) {
        pos -= 1;
        status = state.runningStatus;
      } else {
        state.runningStatus = status;
      }

      if (status === 0xff) {
        const type = view.getUint8(pos++);
        const metaLength = readVarLen(view, () => pos++);
        if (type === 0x03) {
          state.name = readMetaText(view, pos, metaLength);
        } else if (type === 0x05 || type === 0x01) {
          const text = readMetaText(view, pos, metaLength);
          if (text) state.lyrics.push({ tick: state.tick, text: "喵" });
        } else if (type === 0x51 && metaLength === 3) {
          const mpqn = (view.getUint8(pos) << 16) | (view.getUint8(pos + 1) << 8) | view.getUint8(pos + 2);
          tempos.push({ tick: state.tick, mpqn });
        }
        pos += metaLength;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const sysexLength = readVarLen(view, () => pos++);
        pos += sysexLength;
        continue;
      }

      const eventType = status >> 4;
      const channel = status & 0x0f;
      const data1 = view.getUint8(pos++);
      const needsSecond = ![0xc, 0xd].includes(eventType);
      const data2 = needsSecond ? view.getUint8(pos++) : 0;

      if (eventType === 0x9 && data2 > 0) {
        const key = `${channel}:${data1}`;
        if (!state.open.has(key)) state.open.set(key, []);
        state.open.get(key).push({ tick: state.tick, pitch: data1, velocity: data2 / 127 });
      } else if (eventType === 0x8 || (eventType === 0x9 && data2 === 0)) {
        const key = `${channel}:${data1}`;
        const stack = state.open.get(key);
        const started = stack?.shift();
        if (started && state.tick > started.tick) {
          state.notes.push({
            pitch: started.pitch,
            velocity: started.velocity,
            startTick: started.tick,
            endTick: state.tick,
          });
        }
      }
    }

    rawTracks.push({ index: trackIndex, name: state.name, notes: state.notes, lyrics: state.lyrics });
    pos = end;
  }

  const tempoMap = tempos.sort((a, b) => a.tick - b.tick).reduce((map, tempo) => {
    if (map.length && map[map.length - 1].tick === tempo.tick) {
      map[map.length - 1] = tempo;
    } else {
      map.push(tempo);
    }
    return map;
  }, []);
  const tracks = rawTracks.map((track) => ({
    ...track,
    notes: track.notes.map((note) => ({
      pitch: note.pitch,
      velocity: note.velocity,
      start: tickToSeconds(note.startTick, tempoMap, ticksPerBeat),
      end: tickToSeconds(note.endTick, tempoMap, ticksPerBeat),
    })),
    lyrics: mergeCloseLyrics(track.lyrics.map((lyric) => ({
      text: lyric.text,
      time: tickToSeconds(lyric.tick, tempoMap, ticksPerBeat),
    }))),
  }));

  return { format, ticksPerBeat, tempoMap, tracks };
}

function mergeCloseLyrics(lyrics) {
  const sorted = [...lyrics].sort((a, b) => a.time - b.time);
  const merged = [];
  for (const lyric of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && lyric.time - previous.time < 0.02) {
      previous.text = lyric.text;
    } else {
      merged.push({ ...lyric });
    }
  }
  return merged;
}

function lyricsFromNoteStarts(notes) {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const lyrics = [];
  for (const note of sorted) {
    const previous = lyrics[lyrics.length - 1];
    if (previous && note.start - previous.time < 0.1) {
      continue;
    }
    lyrics.push({ text: "喵", time: note.start });
  }
  return lyrics;
}

function readVarLen(view, advance) {
  let value = 0;
  let byte = 0;
  do {
    byte = view.getUint8(advance());
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return value;
}

function readMetaText(view, offset, length) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  try {
    return new TextDecoder("utf-8").decode(bytes).replace(/\0/g, "").trim();
  } catch {
    return "";
  }
}

function tickToSeconds(tick, tempoMap, ticksPerBeat) {
  let seconds = 0;
  for (let i = 0; i < tempoMap.length; i += 1) {
    const current = tempoMap[i];
    const next = tempoMap[i + 1];
    const segmentEnd = next ? Math.min(tick, next.tick) : tick;
    if (segmentEnd > current.tick) {
      seconds += ((segmentEnd - current.tick) * current.mpqn) / ticksPerBeat / 1_000_000;
    }
    if (!next || tick < next.tick) break;
  }
  return seconds;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
}

function formatTime(time) {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  const hundredths = Math.floor((time % 1) * 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return entities[char];
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

resizeCanvas();
drawEmpty();
restoreState();