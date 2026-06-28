// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MidiCharacterExporter",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "NativeRenderer", targets: ["NativeRenderer"])
    ],
    targets: [
        .executableTarget(name: "NativeRenderer")
    ]
)
