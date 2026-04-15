import SwiftUI

extension AppState {
    /// Posts a toast and schedules its automatic dismissal. Cancels any
    /// in-flight dismissal so a fresh toast doesn't disappear early.
    func showToast(title: String, message: String? = nil, style: AppToastStyle = .neutral) {
        let toast = AppToast(title: title, message: message, style: style)
        activeToast = toast

        toastDismissWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
            guard self?.activeToast?.id == toast.id else { return }
            withAnimation(XatlasMotion.fade) {
                self?.activeToast = nil
            }
        }
        toastDismissWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.6, execute: workItem)
    }
}
