// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "xatlas",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "xatlas", targets: ["xatlas"])
    ],
    dependencies: [
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.2.0"),
    ],
    targets: [
        .executableTarget(
            name: "xatlas",
            dependencies: ["SwiftTerm"],
            path: "xatlas"
        )
    ]
)
