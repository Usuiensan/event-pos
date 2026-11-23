import AppKit
import Foundation

final class PowerEvents: NSObject, NSApplicationDelegate {
    private let condition = NSCondition()
    private var launcherClosed = false
    private var sleepSequence = 0
    private var savedSleepSequence = 0
    private var terminationTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(saveBeforeSleep), name: NSWorkspace.willSleepNotification, object: nil
        )
    }

    func readLauncherReplies() {
        while let line = readLine() {
            guard let id = Int(line) else { continue }
            condition.lock()
            savedSleepSequence = max(savedSleepSequence, id)
            condition.broadcast()
            condition.unlock()
        }

        condition.lock()
        launcherClosed = true
        condition.broadcast()
        condition.unlock()
        RunLoop.main.perform(inModes: [.common, .modalPanel]) {
            if self.terminationTimer != nil {
                self.finishTermination()
            } else {
                NSApplication.shared.terminate(nil)
            }
        }
    }

    private func send(_ message: String) {
        FileHandle.standardOutput.write(Data((message + "\n").utf8))
    }

    @objc private func saveBeforeSleep(_ notification: Notification) {
        condition.lock()
        defer { condition.unlock() }
        guard !launcherClosed else { return }
        sleepSequence += 1
        let id = sleepSequence
        send("sleep \(id)")
        let deadline = Date(timeIntervalSinceNow: 5)
        while !launcherClosed && savedSleepSequence < id {
            if !condition.wait(until: deadline) { break }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        condition.lock()
        let alreadyClosed = launcherClosed
        condition.unlock()
        if alreadyClosed { return .terminateNow }

        if terminationTimer == nil {
            let timer = Timer(timeInterval: 10, target: self, selector: #selector(finishTermination), userInfo: nil, repeats: false)
            terminationTimer = timer
            RunLoop.main.add(timer, forMode: .common)
            RunLoop.main.add(timer, forMode: .modalPanel)
            send("shutdown-wait")
        }
        return .terminateLater
    }

    @objc private func finishTermination() {
        terminationTimer?.invalidate()
        terminationTimer = nil
        NSApplication.shared.reply(toApplicationShouldTerminate: true)
    }
}

let delegate = PowerEvents()
let app = NSApplication.shared
app.delegate = delegate
app.setActivationPolicy(.accessory)
DispatchQueue.global().async { delegate.readLauncherReplies() }
app.run()
