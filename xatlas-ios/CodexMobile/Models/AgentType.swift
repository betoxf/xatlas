// FILE: AgentType.swift
// Purpose: Defines supported AI agent types for xatlas multi-agent support.
// Layer: Model
// Exports: AgentType

import Foundation
import SwiftUI

/// The AI coding agents that xatlas can orchestrate.
enum AgentType: String, Codable, Sendable, CaseIterable, Identifiable {
    case claudeCode = "claude-code"
    case codex = "codex"
    case unknown = "unknown"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        case .unknown: return "Agent"
        }
    }

    var shortName: String {
        switch self {
        case .claudeCode: return "Claude"
        case .codex: return "Codex"
        case .unknown: return "Agent"
        }
    }

    var iconName: String {
        switch self {
        case .claudeCode: return "brain.head.profile"
        case .codex: return "terminal"
        case .unknown: return "cpu"
        }
    }

    var accentColor: Color {
        switch self {
        case .claudeCode: return Color(.systemOrange)
        case .codex: return Color(.systemGreen)
        case .unknown: return Color(.systemGray)
        }
    }

    /// Detects agent type from a process name or identifier string.
    static func detect(from identifier: String) -> AgentType {
        let lower = identifier.lowercased()
        if lower.contains("claude") {
            return .claudeCode
        }
        if lower.contains("codex") || lower.contains("openai") {
            return .codex
        }
        return .unknown
    }

    /// Detects agent type from a thread's metadata or runtime config.
    static func detect(runtime: String?, model: String?) -> AgentType {
        if let runtime {
            let lower = runtime.lowercased()
            if lower.contains("claude") || lower.contains("anthropic") {
                return .claudeCode
            }
            if lower.contains("codex") || lower.contains("openai") {
                return .codex
            }
        }
        if let model {
            let lower = model.lowercased()
            if lower.contains("claude") || lower.contains("opus") || lower.contains("sonnet") || lower.contains("haiku") {
                return .claudeCode
            }
            if lower.contains("gpt") || lower.contains("o1") || lower.contains("o3") || lower.contains("o4") {
                return .codex
            }
        }
        return .unknown
    }
}
