import Foundation

extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func shellQuotedForTerminal() -> String {
        if isEmpty {
            return "''"
        }
        return "'" + replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }
}
