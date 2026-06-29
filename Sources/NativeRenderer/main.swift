import AppKit
import AVFoundation
import CoreImage
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import Metal

struct Project: Decodable {
    let width: Int
    let height: Int
    let fps: Int
    let duration: Double
    let transparent: Bool
    let lyricColor: String
    let lyricFont: String
    let lyricHeight: Double
    let tracks: [Track]
    let configs: [CharacterConfig]
    let images: Images
}

struct Track: Decodable {
    let notes: [Note]
    let lyrics: [Lyric]
}

struct Note: Decodable {
    let pitch: Int
    let velocity: Double
    let start: Double
    let end: Double
}

struct Lyric: Decodable {
    let text: String
    let time: Double
}

struct CharacterConfig: Decodable {
    let x: Double
    let y: Double
    let scale: Double
    let tilt: Double
    let color: String?
}

struct Images: Decodable {
    let background: String?
    let defaultClosed: String?
    let defaultOpen: String?
    let tracks: [TrackImages]
}

struct TrackImages: Decodable {
    let closed: String?
    let open: String?
}

struct LoadedImages {
    let background: CIImage?
    let defaultClosed: CIImage?
    let defaultOpen: CIImage?
    let tracks: [(closed: CIImage?, open: CIImage?)]
}

let args = CommandLine.arguments
guard args.count == 3 else {
    fputs("Usage: NativeRenderer <project.json> <output.mov>\n", stderr)
    exit(2)
}

let projectURL = URL(fileURLWithPath: args[1])
let outputURL = URL(fileURLWithPath: args[2])
let project = try JSONDecoder().decode(Project.self, from: Data(contentsOf: projectURL))
try? FileManager.default.removeItem(at: outputURL)

// Best-effort: register the bundled "ZCOOL KuaiLe" font so the default lyric option
// resolves in the renderer (matching the browser's @font-face). Falls back silently.
let bundledFont = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("fonts/zcool-kuaile-miao.woff2")
if FileManager.default.fileExists(atPath: bundledFont.path) {
    _ = CTFontManagerRegisterFontsForURL(bundledFont as CFURL, .process, nil)
}

let device = MTLCreateSystemDefaultDevice()
let ciContext = device.map { CIContext(mtlDevice: $0, options: [.workingColorSpace: CGColorSpaceCreateDeviceRGB()]) }
    ?? CIContext(options: [.workingColorSpace: CGColorSpaceCreateDeviceRGB()])
let colorSpace = CGColorSpaceCreateDeviceRGB()
let loadedImages = LoadedImages(
    background: decodeImage(project.images.background),
    defaultClosed: decodeImage(project.images.defaultClosed),
    defaultOpen: decodeImage(project.images.defaultOpen),
    tracks: project.images.tracks.map { (decodeImage($0.closed), decodeImage($0.open)) }
)

let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
// ProRes 4444 keeps the alpha channel but is roughly twice the size. Only pay that
// cost for transparent exports; opaque exports use 422 to keep the .mov manageable.
let videoCodec: AVVideoCodecType = project.transparent ? .proRes4444 : .proRes422
let videoSettings: [String: Any] = [
    AVVideoCodecKey: videoCodec,
    AVVideoWidthKey: project.width,
    AVVideoHeightKey: project.height
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: project.width,
        kCVPixelBufferHeightKey as String: project.height,
        kCVPixelBufferMetalCompatibilityKey as String: true,
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
    ]
)
writer.add(input)
guard writer.startWriting() else { throw writer.error ?? NSError(domain: "writer", code: 1) }
writer.startSession(atSourceTime: .zero)

let totalFrames = Int(ceil(project.duration * Double(project.fps)))
for frame in 0..<totalFrames {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
    let time = Double(frame) / Double(project.fps)
    guard let buffer = makeBuffer(width: project.width, height: project.height) else {
        throw NSError(domain: "buffer", code: 1)
    }
    let frameImage = renderFrame(time: time, project: project, images: loadedImages)
    ciContext.render(
        frameImage.transformed(by: CGAffineTransform(scaleX: 1, y: -1).translatedBy(x: 0, y: -Double(project.height))),
        to: buffer,
        bounds: CGRect(x: 0, y: 0, width: project.width, height: project.height),
        colorSpace: colorSpace
    )
    let presentationTime = CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(project.fps))
    if !adaptor.append(buffer, withPresentationTime: presentationTime) {
        throw writer.error ?? NSError(domain: "append", code: 1)
    }
    if frame % max(project.fps, 1) == 0 {
        print("\(frame + 1)/\(totalFrames)")
        fflush(stdout)
    }
}

input.markAsFinished()
awaitFinish(writer)
if writer.status != .completed {
    throw writer.error ?? NSError(domain: "writer", code: 2)
}

func awaitFinish(_ writer: AVAssetWriter) {
    let semaphore = DispatchSemaphore(value: 0)
    writer.finishWriting {
        semaphore.signal()
    }
    semaphore.wait()
}

func makeBuffer(width: Int, height: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    CVPixelBufferCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCVPixelFormatType_32BGRA,
        [
            kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true
        ] as CFDictionary,
        &buffer
    )
    return buffer
}

func renderFrame(time: Double, project: Project, images: LoadedImages) -> CIImage {
    let frameRect = CGRect(x: 0, y: 0, width: project.width, height: project.height)
    var output = project.transparent
        ? CIImage(color: .clear).cropped(to: frameRect)
        : CIImage(color: CIColor(red: 1, green: 1, blue: 1, alpha: 1)).cropped(to: frameRect)

    if !project.transparent, let background = images.background {
        // Flip vertically: a y-up CIImage would otherwise render upside down here.
        let covered = cover(background, in: frameRect)
            .transformed(by: CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: Double(project.height)))
            .cropped(to: frameRect)
        output = covered.composited(over: output)
    }

    for index in project.tracks.indices {
        guard index < project.configs.count else { continue }
        let track = project.tracks[index]
        let config = project.configs[index]
        let active = track.notes.filter { $0.start <= time && $0.end > time }
        let note = active.max { $0.pitch < $1.pitch }
        let mouthOpen = isMouthOpen(track: track, note: note, time: time, fps: Double(project.fps))
        let image = mouthOpen
            ? images.tracks[safe: index]?.open ?? images.defaultOpen
            : images.tracks[safe: index]?.closed ?? images.defaultClosed
        let dynamics = characterDynamics(track: track, time: time, index: index, maxTilt: config.tilt)
        if let image {
            output = drawCharacter(image: image, pitchStretch: dynamics.pitchStretch, tilt: dynamics.tilt, config: config, project: project)
                .composited(over: output)
        } else {
            output = drawPlaceholder(note: note, config: config, project: project).composited(over: output)
        }
    }

    return output.cropped(to: frameRect)
}

func drawCharacter(image: CIImage, pitchStretch: Double, tilt: Double, config: CharacterConfig, project: Project) -> CIImage {
    let baseSize = Double(min(project.width, project.height)) * 0.3 * config.scale
    let imgW = image.extent.width
    let imgH = max(image.extent.height, 1)
    let ratio = imgW / imgH
    let targetHeight = baseSize
    let targetWidth = targetHeight * ratio
    let shear = tan(tilt * .pi / 180)

    // Mirror the canvas preview exactly (translate(config) -> shear -> scale(1, pitchStretch),
    // image drawn with x in [-W/2, W/2] and feet at config.y), expressed directly as a single
    // affine map from source pixels to the y-up CoreImage frame (the main loop flips y afterwards).
    // Composing translatedBy/scaledBy (pre-multiply) with concatenating (post-multiply) scrambled
    // the order before, which is what moved every character off its preview position.
    let sx = targetWidth / imgW
    let sy = pitchStretch * targetHeight / imgH
    // Calibrated from an actual rendered frame: the net pipeline maps a CoreImage Y
    // coordinate straight to the top-down screen row (the main-loop flip and the render
    // cancel out), and pixel iy = 0 is the feet. So d = -sy flips the y-up source upright
    // and the transform reproduces the canvas preview's screen coordinates directly:
    //   screen_x = config.x + (ix/imgW - 0.5)*W - shear*sy*iy
    //   screen_y = config.y - sy*iy            (feet land exactly on config.y)
    // Verified against the preview with maxdiff = 0.
    let transform = CGAffineTransform(
        a: sx,
        b: 0,
        c: -shear * sy,
        d: -sy,
        tx: config.x - targetWidth / 2 - sx * image.extent.minX + shear * sy * image.extent.minY,
        ty: config.y + sy * image.extent.minY
    )
    return image.transformed(by: transform)
}

func drawPlaceholder(note: Note?, config: CharacterConfig, project: Project) -> CIImage {
    let size = Double(min(project.width, project.height)) * 0.3 * config.scale
    // screen_row = Y: feet at config.y, body extends up to config.y - size.
    let rect = CGRect(x: config.x - size * 0.38, y: config.y - size, width: size * 0.76, height: size)
    return CIImage(color: CIColor(red: 0.29, green: 0.77, blue: 0.71, alpha: 1)).cropped(to: rect)
}

func drawLyric(lyric: Lyric, time: Double, config: CharacterConfig, project: Project) -> CIImage? {
    // No hold delay: float up, then dissipate immediately (keep == app.js).
    let age = time - lyric.time
    let floatProgress = max(0, min(1, age / 0.7))
    let eased = 1 - pow(1 - floatProgress, 3)
    let fadeStart = 0.7 + 0.0
    let alpha = age <= fadeStart ? 1 : 1 - max(0, min(1, (age - fadeStart) / 0.3))
    if alpha <= 0 { return nil }

    let size = Double(min(project.width, project.height)) * 0.3 * config.scale
    let fontSize = max(18, min(96, size * 0.22))
    let width = Int(max(160, fontSize * 3))
    let height = Int(fontSize * 1.6)
    guard let cgImage = textImage(text: lyric.text, width: width, height: height, fontSize: fontSize, color: project.lyricColor, alpha: alpha, fontCSS: project.lyricFont) else {
        return nil
    }
    let x = config.x - Double(width) / 2
    // screen_row = Y. The text bitmap is already pre-flipped inside textImage, so here it
    // needs d:+1 (no extra flip) to read upright; ty places the block's top at yTop.
    let yTop = config.y - size - 28 - project.lyricHeight - eased * 120 - Double(height)
    return CIImage(cgImage: cgImage).transformed(by: CGAffineTransform(a: 1, b: 0, c: 0, d: 1, tx: x, ty: yTop))
}

// Resolve the project's CSS font-family string to a concrete (bold) macOS font so the
// export matches the preview instead of falling back to the system face.
func resolveCTFont(_ css: String, size: Double) -> CTFont {
    for raw in css.split(separator: ",") {
        var name = String(raw).trimmingCharacters(in: CharacterSet(charactersIn: " \t'\""))
        switch name.lowercased() {
        case "serif": name = "Songti SC"
        case "sans-serif", "system-ui", "-apple-system", "ui-sans-serif": name = "PingFang SC"
        case "cursive": name = "Hannotate SC"
        case "monospace", "ui-monospace": name = "Menlo"
        default: break
        }
        if let font = NSFont(name: name, size: size) {
            let ct = font as CTFont
            return CTFontCreateCopyWithSymbolicTraits(ct, size, nil, .traitBold, .traitBold) ?? ct
        }
    }
    return NSFont.boldSystemFont(ofSize: size) as CTFont
}

func textImage(text: String, width: Int, height: Int, fontSize: Double, color: String, alpha: Double, fontCSS: String) -> CGImage? {
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))
    context.textMatrix = .identity
    context.translateBy(x: 0, y: Double(height))
    context.scaleBy(x: 1, y: -1)

    let cgColor = parseColor(color, alpha: alpha)
    let font = resolveCTFont(fontCSS, size: fontSize)
    let attrs: [CFString: Any] = [
        kCTFontAttributeName: font,
        kCTForegroundColorAttributeName: cgColor
    ]
    let attributed = CFAttributedStringCreate(nil, text as CFString, attrs as CFDictionary)!
    let line = CTLineCreateWithAttributedString(attributed)
    let bounds = CTLineGetBoundsWithOptions(line, [])
    context.textPosition = CGPoint(x: (Double(width) - bounds.width) / 2 - bounds.minX, y: (Double(height) - bounds.height) / 2 - bounds.minY)
    CTLineDraw(line, context)
    return context.makeImage()
}

func cover(_ image: CIImage, in rect: CGRect) -> CIImage {
    let imageRatio = image.extent.width / image.extent.height
    let targetRatio = rect.width / rect.height
    let scale = imageRatio > targetRatio ? rect.height / image.extent.height : rect.width / image.extent.width
    let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let x = rect.midX - scaled.extent.width / 2 - scaled.extent.minX
    let y = rect.midY - scaled.extent.height / 2 - scaled.extent.minY
    return scaled.transformed(by: CGAffineTransform(translationX: x, y: y)).cropped(to: rect)
}

func currentLyric(track: Track, time: Double) -> Lyric? {
    var lyric: Lyric?
    for candidate in track.lyrics {
        if candidate.time <= time { lyric = candidate } else { break }
    }
    guard let lyric, time - lyric.time <= 1.0 else { return nil }
    return lyric
}

func decodeImage(_ dataURL: String?) -> CIImage? {
    guard let dataURL, let comma = dataURL.firstIndex(of: ",") else { return nil }
    let encoded = String(dataURL[dataURL.index(after: comma)...])
    guard let data = Data(base64Encoded: encoded),
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    return CIImage(cgImage: image)
}

func parseColor(_ hex: String, alpha: Double) -> CGColor {
    let clean = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    let value = Int(clean, radix: 16) ?? 0x171b1f
    let r = CGFloat((value >> 16) & 0xff) / 255
    let g = CGFloat((value >> 8) & 0xff) / 255
    let b = CGFloat(value & 0xff) / 255
    return CGColor(red: r, green: g, blue: b, alpha: CGFloat(alpha))
}

func smoothstep01(_ x: Double) -> Double {
    let t = max(0, min(1, x))
    return t * t * (3 - 2 * t)
}

// Continuous tilt direction in [-1, 1]: the old per-1/8s random value, now interpolated
// across each bucket with smoothstep so the tilt eases instead of snapping.
func tiltDirection(time: Double, index: Int, pitch: Int) -> Double {
    func dir(_ bucket: Double) -> Double {
        let seed = sin((bucket + 1) * 9898.233 + Double(index) * 313.7 + Double(pitch) * 19.19) * 43758.5453
        return (seed - floor(seed) - 0.5) * 2
    }
    let f = time * 8
    let b = floor(f)
    return dir(b) + (dir(b + 1) - dir(b)) * smoothstep01(f - b)
}

// Eased height (pitchStretch) and tilt. Attack when a note starts, release after it ends.
// Force a 2-frame closed mouth at the start of any note that follows another with no
// real gap (consecutive/legato notes), so runs re-articulate instead of holding open.
func isMouthOpen(track: Track, note: Note?, time: Double, fps: Double) -> Bool {
    guard let note = note else { return false }
    let gapTol = 1.0 / fps
    let rearticulated = track.notes.contains { $0.start < note.start && $0.end >= note.start - gapTol }
    if rearticulated && (time - note.start) < 2.0 / fps { return false }
    return true
}

func characterDynamics(track: Track, time: Double, index: Int, maxTilt: Double) -> (pitchStretch: Double, tilt: Double) {
    let attack = 0.05   // faster upward stretch at note start (keep == app.js)
    let release = 0.18  // ease-out after a note ends (keep == app.js)

    func targetStretch(_ pitch: Int) -> Double {
        1 + max(-1, min(1, Double(pitch - 55) / 24)) * 0.2 // 55 = G3 base pitch
    }
    // Deviation (pitchStretch - 1) and tilt left by a note's release tail at `time`.
    func releaseDevTilt(_ note: Note?) -> (dev: Double, tilt: Double) {
        guard let note = note else { return (0, 0) }
        let relProg = (time - note.end) / release
        guard relProg >= 0, relProg < 1 else { return (0, 0) }
        let attackAtEnd = smoothstep01((note.end - note.start) / attack)
        let env = attackAtEnd * (1 - smoothstep01(relProg))
        let dev = (targetStretch(note.pitch) - 1) * env
        let tilt = tiltDirection(time: time, index: index, pitch: note.pitch) * maxTilt * env
        return (dev, tilt)
    }

    let active = track.notes.filter { $0.start <= time && $0.end > time }
    if let note = active.max(by: { $0.pitch < $1.pitch }) {
        // Crossfade from the height/tilt the previous note still has at this moment into
        // this note's target, so a new note grows from the current height (no instant jump).
        let attackProg = smoothstep01((time - note.start) / attack)
        let targetDev = targetStretch(note.pitch) - 1
        let targetTilt = tiltDirection(time: time, index: index, pitch: note.pitch) * maxTilt
        let prev = track.notes.filter { $0.end <= note.start }.max(by: { $0.end < $1.end })
        let residual = releaseDevTilt(prev)
        let dev = residual.dev + (targetDev - residual.dev) * attackProg
        let tilt = residual.tilt + (targetTilt - residual.tilt) * attackProg
        return (1 + dev, tilt)
    }
    if let note = (track.notes.filter { $0.end <= time && time < $0.end + release }).max(by: { $0.end < $1.end }) {
        let r = releaseDevTilt(note)
        return (1 + r.dev, r.tilt)
    }
    return (1, 0)
}

extension Array {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}