// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "xatlas-ios",
    platforms: [.iOS(.v26), .macOS(.v26)],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [
        .executableTarget(
            name: "xatlas-ios",
            dependencies: ["SwiftTerm"],
            path: "xatlas-ios"
        )
    ]
)
