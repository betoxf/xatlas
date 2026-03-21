// FILE: TurnGitBranchSelectorTests.swift
// Purpose: Verifies new branch creation names normalize toward the xatlas/ prefix without double-prefixing.
// Layer: Unit Test
// Exports: TurnGitBranchSelectorTests
// Depends on: XCTest, CodexMobile

import XCTest
@testable import CodexMobile

final class TurnGitBranchSelectorTests: XCTestCase {
    func testNormalizesCreatedBranchNamesTowardxatlasPrefix() {
        XCTAssertEqual(xatlasNormalizedCreatedBranchName("foo"), "xatlas/foo")
        XCTAssertEqual(xatlasNormalizedCreatedBranchName("xatlas/foo"), "xatlas/foo")
        XCTAssertEqual(xatlasNormalizedCreatedBranchName("  foo  "), "xatlas/foo")
    }

    func testNormalizesEmptyBranchNamesToEmptyString() {
        XCTAssertEqual(xatlasNormalizedCreatedBranchName("   "), "")
    }

    func testCurrentBranchSelectionDisablesCheckedOutElsewhereRowsWhenWorktreePathIsMissing() {
        XCTAssertTrue(
            xatlasCurrentBranchSelectionIsDisabled(
                branch: "xatlas/feature-a",
                currentBranch: "main",
                gitBranchesCheckedOutElsewhere: ["xatlas/feature-a"],
                gitWorktreePathsByBranch: [:],
                allowsSelectingCurrentBranch: true
            )
        )
    }

    func testCurrentBranchSelectionKeepsCheckedOutElsewhereRowsEnabledWhenWorktreePathExists() {
        XCTAssertFalse(
            xatlasCurrentBranchSelectionIsDisabled(
                branch: "xatlas/feature-a",
                currentBranch: "main",
                gitBranchesCheckedOutElsewhere: ["xatlas/feature-a"],
                gitWorktreePathsByBranch: ["xatlas/feature-a": "/tmp/xatlas-feature-a"],
                allowsSelectingCurrentBranch: true
            )
        )
    }
}
