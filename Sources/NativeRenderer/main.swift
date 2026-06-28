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
let videoSettings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.proRes4444,
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
        frameImage,
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
        output = cover(background, in: frameRect).composited(over: output)
    }

    for index in project.tracks.indices {
        guard index < project.configs.count else { continue }
        let track = project.tracks[index]
        let config = project.configs[index]
        let active = track.notes.filter { $0.start <= time && $0.end > time }
        let note = active.max { $0.pitch < $1.pitch }
        let image = note == nil
            ? images.tracks[safe: index]?.closed ?? images.defaultClosed
            : images.tracks[safe: index]?.open ?? images.defaultOpen
        if let image {
            output = drawCharacter(image: image, note: note, time: time, index: index, config: config, project: project)
                .composited(over: output)
        } else {
            output = drawPlaceholder(note: note, config: config, project: project).composited(over: output)
        }
        if let lyric = currentLyric(track: track, time: time),
           let lyricImage = drawLyric(lyric: lyric, time: time, config: config, project: project) {
            output = lyricImage.composited(over: output)
        }
    }

    return output.cropped(to: frameRect)
}

func drawCharacter(image: CIImage, note: Note?, time: Double, index: Int, config: CharacterConfig, project: Project) -> CIImage {
    let baseSize = Double(min(project.width, project.height)) * 0.3 * config.scale
    let ratio = image.extent.width / max(image.extent.height, 1)
    let targetHeight = baseSize
    let targetWidth = targetHeight * ratio
    let pitchStretch = note.map { 1 + max(-1, min(1, Double($0.pitch - 60) / 24)) * 0.2 } ?? 1
    let tilt = note.map { seededTilt(time: time, index: index, pitch: $0.pitch, maxTilt: config.tilt) } ?? 0
    let shear = tan(tilt * .pi / 180)

    var transform = CGAffineTransform.identity
    transform = transform.translatedBy(x: -image.extent.midX, y: -image.extent.midY)
    transform = transform.scaledBy(x: targetWidth / image.extent.width, y: targetHeight / image.extent.height * pitchStretch)
    transform = transform.concatenating(CGAffineTransform(a: 1, b: 0, c: shear, d: 1, tx: 0, ty: 0))
    transform = transform.translatedBy(
        x: config.x - shear * targetHeight * pitchStretch / 2,
        y: config.y - targetHeight * pitchStretch / 2
    )
    return image.transformed(by: transform)
}

func drawPlaceholder(note: Note?, config: CharacterConfig, project: Project) -> CIImage {
    let size = Double(min(project.width, project.height)) * 0.3 * config.scale
    let rect = CGRect(x: config.x - size * 0.38, y: config.y - size, width: size * 0.76, height: size)
    return CIImage(color: CIColor(red: 0.29, green: 0.77, blue: 0.71, alpha: 1)).cropped(to: rect)
}

func drawLyric(lyric: Lyric, time: Double, config: CharacterConfig, project: Project) -> CIImage? {
    let age = time - lyric.time
    let floatProgress = max(0, min(1, age / 0.7))
    let eased = 1 - pow(1 - floatProgress, 3)
    let fadeStart = 0.7 + 2.0
    let alpha = age <= fadeStart ? 1 : 1 - max(0, min(1, (age - fadeStart) / 0.1))
    if alpha <= 0 { return nil }

    let size = Double(min(project.width, project.height)) * 0.3 * config.scale
    let fontSize = max(18, min(96, size * 0.22))
    let width = Int(max(160, fontSize * 3))
    let height = Int(fontSize * 1.6)
    guard let cgImage = textImage(text: lyric.text, width: width, height: height, fontSize: fontSize, color: project.lyricColor, alpha: alpha) else {
        return nil
    }
    let x = config.x - Double(width) / 2
    let yTop = config.y - size - 28 - project.lyricHeight + eased * 120 - Double(height)
    let y = yTop
    return CIImage(cgImage: cgImage).transformed(by: CGAffineTransform(translationX: x, y: y))
}

func textImage(text: String, width: Int, height: Int, fontSize: Double, color: String, alpha: Double) -> CGImage? {
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

    let cgColor = parseColor(color, alpha: alpha)
    let font = CTFontCreateWithName("ZCOOL KuaiLe" as CFString, fontSize, nil)
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
    guard let lyric, time - lyric.time <= 2.8 else { return nil }
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

func seededTilt(time: Double, index: Int, pitch: Int, maxTilt: Double) -> Double {
    let bucket = floor(time * 8)
    let seed = sin((bucket + 1) * 9898.233 + Double(index) * 313.7 + Double(pitch) * 19.19) * 43758.5453
    return (seed - floor(seed) - 0.5) * 2 * maxTilt
}

extension Array {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
