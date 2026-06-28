"use strict";

const { createServer } = require("node:http");
const { createReadStream, promises: fs } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");

const root = __dirname;
const port = Number(process.env.PORT || 8787);
const ffmpeg = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
const exportsDir = path.join(root, "exports");
const nativeRenderer = path.join(root, ".build/release/NativeRenderer");
const exportJobs = new Map();
const CHARACTER_SIZE_RATIO = 0.3;
const LYRIC_FLOAT_DURATION = 0.7;
const LYRIC_HOLD_DURATION = 2;
const LYRIC_FADE_DURATION = 0.1;
const LYRIC_TOTAL_DURATION = LYRIC_FLOAT_DURATION + LYRIC_HOLD_DURATION + LYRIC_FADE_DURATION;

GlobalFonts.registerFromPath(path.join(root, "fonts/zcool-kuaile-miao.woff2"), "ZCOOL KuaiLe");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".mov": "video/quicktime",
};

createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/render-mov") {
      await renderMovStart(req, res);
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/render-progress")) {
      await renderProgress(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/export-start") {
      await exportStart(req, res);
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/export-frame")) {
      await exportFrame(req, res);
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/export-finish")) {
      await exportFinish(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error.stack || String(error));
  }
}).listen(port, () => {
  console.log(`MOV exporter running at http://localhost:${port}`);
});

async function renderMovStart(req, res) {
  const project = JSON.parse((await readBody(req)).toString("utf8"));
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const job = {
    id,
    status: "running",
    frame: 0,
    totalFrames: Math.ceil(project.duration * (Number(project.fps) || 60)),
    output: null,
    error: null,
  };
  exportJobs.set(id, job);
  renderMovJob(project, job).catch((error) => {
    job.status = "error";
    job.error = error.stack || String(error);
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id }));
}

async function renderProgress(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const id = url.searchParams.get("id");
  const job = exportJobs.get(id);
  if (!job) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "missing" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(job));
}

async function renderMovJob(project, job) {
  await fs.mkdir(exportsDir, { recursive: true });
  const filename = `midi-characters-${new Date().toISOString().replace(/[:.]/g, "-")}.mov`;
  const output = path.join(exportsDir, filename);
  const projectPath = path.join(os.tmpdir(), `midi-characters-${job.id}.json`);
  await fs.writeFile(projectPath, JSON.stringify(project));
  await runNativeRenderer(projectPath, output, job);
  await fs.rm(projectPath, { force: true });
  job.status = "done";
  job.output = {
    url: `/exports/${filename}`,
    path: output,
    filename,
  };
}

async function runNativeRenderer(projectPath, output, job) {
  await fs.access(nativeRenderer);
  const child = spawn(nativeRenderer, [projectPath, output], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    for (const line of text.trim().split(/\n+/)) {
      const match = line.match(/^(\d+)\/(\d+)$/);
      if (match) {
        job.frame = Number(match[1]);
        job.totalFrames = Number(match[2]);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${nativeRenderer} exited ${code}\n${stderr}`));
    });
  });
}

async function renderMovJobLegacy(project, job) {
  await fs.mkdir(exportsDir, { recursive: true });
  const filename = `midi-characters-${new Date().toISOString().replace(/[:.]/g, "-")}.mov`;
  const output = path.join(exportsDir, filename);
  const width = Number(project.width) || 3840;
  const height = Number(project.height) || 2160;
  const fps = Number(project.fps) || 60;
  const totalFrames = Math.ceil(project.duration * fps);
  const transparent = Boolean(project.transparent);
  const pixelFormat = transparent ? "yuva444p10le" : "yuv422p10le";
  const profile = transparent ? "4" : "3";
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const assets = await loadAssets(project);

  const child = spawn(ffmpeg, [
    "-y",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s:v",
    `${width}x${height}`,
    "-r",
    String(fps),
    "-i",
    "pipe:0",
    "-an",
    "-c:v",
    "prores_ks",
    "-profile:v",
    profile,
    "-pix_fmt",
    pixelFormat,
    output,
  ], { stdio: ["pipe", "ignore", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${ffmpeg} exited ${code}\n${stderr}`));
    });
  });

  for (let frame = 0; frame < totalFrames; frame += 1) {
    drawServerFrame(ctx, canvas, project, assets, frame / fps);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    await writeToStream(child.stdin, Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength));
    job.frame = frame + 1;
  }
  child.stdin.end();
  await done;
  job.status = "done";
  job.output = {
    url: `/exports/${filename}`,
    path: output,
    filename,
  };
}

async function loadAssets(project) {
  return {
    background: await loadOptionalImage(project.images?.background),
    defaultClosed: await loadOptionalImage(project.images?.defaultClosed),
    defaultOpen: await loadOptionalImage(project.images?.defaultOpen),
    tracks: await Promise.all((project.images?.tracks || []).map(async (track) => ({
      closed: await loadOptionalImage(track?.closed),
      open: await loadOptionalImage(track?.open),
    }))),
  };
}

async function loadOptionalImage(dataUrl) {
  if (!dataUrl) return null;
  return loadImage(Buffer.from(dataUrl.split(",")[1], "base64"));
}

function drawServerFrame(ctx, canvas, project, assets, time) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawServerBackground(ctx, canvas, project, assets);
  for (let index = 0; index < project.tracks.length; index += 1) {
    const track = project.tracks[index];
    const config = project.configs[index];
    const active = track.notes.filter((note) => note.start <= time && note.end > time);
    const note = active.length ? active.reduce((highest, current) => (current.pitch > highest.pitch ? current : highest)) : null;
    drawServerCharacter(ctx, canvas, config, assets, note, time, index);
    drawServerLyric(ctx, canvas, project, config, track, time);
  }
}

function drawServerBackground(ctx, canvas, project, assets) {
  if (project.transparent) return;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (assets.background) drawCoverImage(ctx, assets.background, 0, 0, canvas.width, canvas.height);
}

function drawCoverImage(ctx, image, x, y, width, height) {
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

function drawServerCharacter(ctx, canvas, config, assets, note, time, index) {
  const trackAssets = assets.tracks[index] || {};
  const image = note ? trackAssets.open || assets.defaultOpen : trackAssets.closed || assets.defaultClosed;
  const baseSize = Math.min(canvas.width, canvas.height) * CHARACTER_SIZE_RATIO * config.scale;
  const pitchStretch = note ? 1 + clamp((note.pitch - 60) / 24, -1, 1) * 0.2 : 1;
  const tilt = note ? seededTilt(time, index, note.pitch, config.tilt) : 0;

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
    drawServerPlaceholder(ctx, config, Boolean(note), baseSize);
  }
  ctx.restore();
}

function drawServerPlaceholder(ctx, config, isOpen, size) {
  ctx.fillStyle = config.color || "#49c5b6";
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
  if (isOpen) ctx.ellipse(0, -size * 0.42, size * 0.12, size * 0.18, 0, 0, Math.PI * 2);
  else {
    ctx.moveTo(-size * 0.14, -size * 0.42);
    ctx.lineTo(size * 0.14, -size * 0.42);
  }
  ctx.stroke();
}

function drawServerLyric(ctx, canvas, project, config, track, time) {
  const lyric = currentLyric(track, time);
  if (!lyric) return;
  const age = time - lyric.time;
  const floatProgress = clamp(age / LYRIC_FLOAT_DURATION, 0, 1);
  const eased = 1 - (1 - floatProgress) ** 3;
  const fadeStart = LYRIC_FLOAT_DURATION + LYRIC_HOLD_DURATION;
  const alpha = age <= fadeStart ? 1 : 1 - clamp((age - fadeStart) / LYRIC_FADE_DURATION, 0, 1);
  if (alpha <= 0) return;

  const size = Math.min(canvas.width, canvas.height) * CHARACTER_SIZE_RATIO * config.scale;
  const x = clamp(config.x, 18, canvas.width - 18);
  const y = Math.max(32, config.y - size - 28 - Number(project.lyricHeight || 0) - eased * 120);
  const fontSize = clamp(size * 0.22, 18, 96);
  const fontFamily = project.lyricFont || '"ZCOOL KuaiLe", system-ui, sans-serif';
  const font = `700 ${fontSize}px ${fontFamily}`;
  const maxWidth = Math.max(120, Math.min(canvas.width * 0.42, size * 2.8));
  const lines = wrapText(ctx, lyric.text, maxWidth, font);
  const lineHeight = fontSize * 1.22;
  const textY = y - lines.length * lineHeight;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = project.lyricColor || "#171b1f";
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  lines.forEach((line, lineIndex) => {
    ctx.fillText(line, x, textY + lineHeight * lineIndex + lineHeight / 2);
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

function wrapText(ctx, text, maxWidth, font) {
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

function seededTilt(time, index, pitch, maxTilt) {
  const bucket = Math.floor(time * 8);
  const seed = Math.sin((bucket + 1) * 9898.233 + index * 313.7 + pitch * 19.19) * 43758.5453;
  return (seed - Math.floor(seed) - 0.5) * 2 * maxTilt;
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://localhost:${port}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(root, requested));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  const ext = path.extname(file);
  try {
    await fs.access(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "content-type": mime[ext] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

async function exportStart(req, res) {
  const body = JSON.parse((await readBody(req)).toString("utf8"));
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dir = path.join(os.tmpdir(), `midi-characters-${id}`);
  const output = path.join(dir, "midi-characters.mov");
  const fps = Number(body.fps) || 60;
  const transparent = Boolean(body.transparent);
  const inputCodec = transparent ? "png" : "mjpeg";
  const pixelFormat = transparent ? "yuva444p10le" : "yuv422p10le";
  const profile = transparent ? "4" : "3";
  await fs.mkdir(dir, { recursive: true });
  const child = spawn(ffmpeg, [
    "-y",
    "-framerate",
    String(fps),
    "-f",
    "image2pipe",
    "-vcodec",
    inputCodec,
    "-i",
    "pipe:0",
    "-c:v",
    "prores_ks",
    "-profile:v",
    profile,
    "-pix_fmt",
    pixelFormat,
    output,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  exportJobs.set(id, {
    child,
    dir,
    output,
    stderr,
    done: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${ffmpeg} exited ${code}\n${stderr}`));
      });
    }),
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id }));
}

async function exportFrame(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const id = url.searchParams.get("id");
  const index = Number(url.searchParams.get("index"));
  const job = exportJobs.get(id);
  if (!job || !Number.isFinite(index)) {
    res.writeHead(400);
    res.end("Invalid export job.");
    return;
  }
  const frame = await readBody(req);
  await writeToStream(job.child.stdin, frame);
  res.writeHead(204);
  res.end();
}

async function exportFinish(req, res) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const id = url.searchParams.get("id");
  const job = exportJobs.get(id);
  if (!job) {
    res.writeHead(400);
    res.end("Invalid export job.");
    return;
  }
  job.child.stdin.end();
  await job.done;

  await fs.mkdir(exportsDir, { recursive: true });
  const filename = `midi-characters-${new Date().toISOString().replace(/[:.]/g, "-")}.mov`;
  const finalPath = path.join(exportsDir, filename);
  await fs.rename(job.output, finalPath);
  await fs.rm(job.dir, { recursive: true, force: true });
  exportJobs.delete(id);

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    url: `/exports/${filename}`,
    path: finalPath,
    filename,
  }));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}\n${stderr}`));
    });
  });
}

function writeToStream(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
